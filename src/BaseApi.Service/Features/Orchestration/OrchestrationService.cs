using System.Text.Json;
using BaseApi.Core.Exceptions;
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Cache;
using BaseApi.Service.Features.Orchestration.Loading;
using BaseApi.Service.Features.Orchestration.Validation;
using BaseApi.Service.Features.Workflow;
using FluentValidation;
using FluentValidation.Results;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;

namespace BaseApi.Service.Features.Orchestration;

/// <summary>
/// Thin cross-entity orchestrator. Deliberately not a <c>BaseService</c> subclass — there is no
/// single entity to project.
/// <para>
/// <b>Both verbs validate synchronously and apply asynchronously, and the split is the design.</b>
/// Everything that can tell the caller they are wrong — an unknown workflow, a cyclic graph,
/// mismatched schemas, a dead processor — happens here, while there is still a request to answer. The
/// projection write itself is sent to a durable queue and applied by a consumer, because it is the one
/// step that must survive the store being unavailable, and no HTTP request can wait that long.
/// </para>
/// <para>
/// <b>Neither path touches the projection store for writing.</b> The only contact here is the
/// liveness gate's reads, which produce a 422 for a dead processor and a 500 for a transport fault —
/// tagged with a stable operation name so the response body names an operation rather than an error.
/// </para>
/// </summary>
public sealed class OrchestrationService
{
    private readonly BaseDbContext _db;
    private readonly IWorkflowGraphLoader _loader;
    private readonly CycleDetector _cycleDetector;
    private readonly SchemaEdgeValidator _schemaEdgeValidator;
    private readonly PayloadConfigSchemaValidator _payloadConfigSchemaValidator;
    private readonly ProcessorLivenessValidator _processorLivenessValidator;
    private readonly IQueueSender _sender;
    private readonly ILogger<OrchestrationService> _logger;

    // The constructor is internal rather than public: it accepts internal seam types, which the
    // compiler forbids on a public member. The class itself stays public and sealed so the
    // controller can inject the concrete type. Dependency injection resolves this in-assembly.
    internal OrchestrationService(
        BaseDbContext db,
        IWorkflowGraphLoader loader,
        CycleDetector cycleDetector,
        SchemaEdgeValidator schemaEdgeValidator,
        PayloadConfigSchemaValidator payloadConfigSchemaValidator,
        ProcessorLivenessValidator processorLivenessValidator,
        IQueueSender sender,
        ILogger<OrchestrationService> logger)
    {
        _db                           = db                           ?? throw new ArgumentNullException(nameof(db));
        _loader                       = loader                       ?? throw new ArgumentNullException(nameof(loader));
        _cycleDetector                = cycleDetector                ?? throw new ArgumentNullException(nameof(cycleDetector));
        _schemaEdgeValidator          = schemaEdgeValidator          ?? throw new ArgumentNullException(nameof(schemaEdgeValidator));
        _payloadConfigSchemaValidator = payloadConfigSchemaValidator ?? throw new ArgumentNullException(nameof(payloadConfigSchemaValidator));
        _processorLivenessValidator   = processorLivenessValidator   ?? throw new ArgumentNullException(nameof(processorLivenessValidator));
        _sender                       = sender                       ?? throw new ArgumentNullException(nameof(sender));
        _logger                       = logger                       ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>
    /// Validates one workflow and its graph, then sends the validated definition to be projected.
    /// <para>
    /// The gate order is locked: existence, then cycle, then schema edge, then payload against config
    /// schema, then processor liveness. The snapshot is disposed by the <c>using</c> declaration on
    /// success and on any throw above it.
    /// </para>
    /// </summary>
    public async Task StartAsync(Guid workflowId, CancellationToken ct)
    {
        await ExistenceCheckAsync(workflowId, ct);

        // The loader takes a list; this path always supplies exactly one id.
        using var snapshot = await _loader.LoadL1Async(new[] { workflowId }, ct);

        // The gate order is locked: cycle, then schema edge, then payload against config schema.
        //
        // WHICH WORKFLOW WAS REFUSED IS TAGGED HERE, because the gates do not know. A gate sees a
        // snapshot and throws about the step, edge or assignment it found; nothing in the exception
        // says which start request that was. The refusal log is written by the problem-details
        // customizer, so without this a 422 reaches the log store with no WorkflowId at all -- and a
        // query filtered by workflow, which is the obvious query, returns NOTHING for a refused
        // start. Indistinguishable from a request that was never made.
        try
        {
            _cycleDetector.Validate(snapshot);
            _schemaEdgeValidator.Validate(snapshot);
            _payloadConfigSchemaValidator.Validate(snapshot);
        }
        catch (OrchestrationValidationException ex)
        {
            ex.Data["workflowId"] = workflowId;
            throw;
        }

        // A dead or stale processor throws OrchestrationValidationException (gate
        // "processorLiveness") and propagates past this catch to the 422 handler. Only a transport
        // fault is tagged here, so the 500 body reports a stable op name.
        try
        {
            await _processorLivenessValidator.ValidateAsync(snapshot, ct);
        }
        catch (RedisException ex)
        {
            ex.Data["redisOp"] = "ProcessorLiveness";
            throw;
        }
        catch (OrchestrationValidationException ex)
        {
            // The liveness gate refuses too, and it is outside the block above.
            ex.Data["workflowId"] = workflowId;
            throw;
        }

        var definition = ToDefinition(snapshot, workflowId);

        // THE ONLY PLACE AN ENTITY ID AND ITS NAME ARE EVER SEEN TOGETHER IN A LOG RECORD, and that
        // is why these lines are here rather than anywhere more obvious. Every downstream record —
        // every step outcome, every dispatch, every orchestrator line — carries WorkflowId, StepId
        // and ProcessorId and nothing readable. Grafana and Kibana can both group by those ids; a
        // human reading the result cannot tell which GUID is the importer.
        //
        // Emitting these pairs lets a reader build the id -> name map from the LOG STORE ALONE. That
        // is the point: a dashboard on someone else's Elasticsearch gets readable labels without an
        // enrich policy, a lookup index, a sync script or any privilege beyond read, and without
        // calling this API at the time it renders. Section 13.2 and 13.6 of
        // docs/superpowers/specs/2026-09-22-kibana-operator-dashboard-design.md are the argument.
        //
        // HERE AND NOT IN THE ORCHESTRATOR, because the names do not survive the projection --
        // WorkflowL1 and StepL1 are ids-only. The snapshot above is the last place a Name and a
        // Version exist in the same object as the Id, and it is disposed shortly after this.
        //
        // AFTER every gate, so a refused start emits no pairs. A workflow that cannot run should not
        // seed a legend with labels for steps nobody will ever see counted.
        //
        // EntityKind is carried because a reader cannot recover it: these records say "this GUID is
        // called that", and nothing in them says whether the GUID belongs in the Workflow control or
        // the Step control. Without it the reader would have to guess from which field the id later
        // appears in, which is exactly the join being avoided.
        //
        // ONE LINE PER ENTITY PER ACCEPTED START, AND A START IS RARE. The cron does NOT come through
        // here -- WorkflowFireJob lives in the Orchestrator and fires against the L1 projection, which
        // is ids-only -- so these lines are written when a human or a client starts a workflow, and
        // not again until the next start. A workflow started last week and running ever since has
        // emitted its pairs once, at that moment.
        //
        // THAT IS A RETENTION DEPENDENCY AND A READER MUST KNOW IT. A reader building the id -> name
        // map has to search far enough back to find the last start, not the last few minutes, and a
        // workflow whose start has aged out of the index has no pairs at all until it is next
        // started. The alternative -- re-emitting on every tick -- was rejected: on a 30-second cron
        // that is ~55k records a day per workflow to restate something that changes when someone
        // edits a row, and the log store is not the right place to hold a lookup table by brute
        // force. A reader that cannot find a pair should show the raw id, which is legible if ugly.
        // THE ID GOES UNDER THE SAME FIELD NAME THE EXECUTION RECORDS USE -- WorkflowId, StepId,
        // ProcessorId -- rather than a single generic EntityId, and that is not cosmetic.
        //
        // A reader's dropdown is populated from the values of ONE field. If these records carried
        // EntityId, the Step dropdown would still have to read attributes.StepId, and the only
        // records carrying that are executions: a step that has never run would be missing from the
        // list entirely, no matter how the dropdown is configured. Writing the id under its own
        // field means a published step has a record naming it from the moment its workflow is
        // started, so the list is the published topology rather than a list of what happened to
        // fire recently.
        //
        // These records carry NO Result, so nothing that counts outcomes can pick them up -- the
        // counted set is defined by Result being present. They will, however, show up for anyone
        // querying "records for step X" without qualifying it further, which is the same care a
        // lineage query already has to take here.
        foreach (var (kind, scope, name, version) in NameablesOf(snapshot))
        {
            // The field names vary per entity kind, so the scope is built by hand rather than
            // through a message template -- a template's parameter name is fixed at compile time.
            using (_logger.BeginScope(scope))
            {
                _logger.LogInformation("{EntityKind} is named {EntityName}", kind, $"{name}_{version}");
            }
        }

        // The broker is a hard dependency for this path: a send that fails means the projection will
        // never be applied, and the caller has to learn that now rather than be told the work was
        // accepted. The fault is tagged so the response body names a stable operation instead of
        // leaking a transport message that can carry host and credential detail.
        try
        {
            await _sender.SendAsync(
                OrchestratorQueues.Control, MessageTypes.StartOrchestration, new StartOrchestration(definition), ct);
        }
        catch (Exception ex)
        {
            ex.Data["brokerOp"] = "SendStartOrchestration";
            throw;
        }

        _logger.LogInformation("accepted start for workflow {WorkflowId}", workflowId);
    }

    /// <summary>
    /// Validates the requested workflow id and sends the removal.
    /// <para>
    /// There is deliberately no existence check. A stop is a statement about the projection, not about
    /// the workflow row, and the two can legitimately disagree — a workflow may be deleted while its
    /// projection is still stored, and refusing to clean that up would strand it permanently.
    /// </para>
    /// </summary>
    public async Task StopAsync(Guid workflowId, CancellationToken ct)
    {
        GuardNotEmpty(workflowId);

        try
        {
            await _sender.SendAsync(
                OrchestratorQueues.Control, MessageTypes.StopOrchestration, new StopOrchestration(workflowId), ct);
        }
        catch (Exception ex)
        {
            ex.Data["brokerOp"] = "SendStopOrchestration";
            throw;
        }

        _logger.LogInformation("accepted stop for workflow {WorkflowId}", workflowId);
    }

    /// <summary>
    /// Every entity in the snapshot that has both an id and a human-readable name, flattened into
    /// one sequence so the caller logs them in a single loop.
    /// <para>
    /// <b>Schemas, assignments and caches are left out.</b> They carry names too, but no log record
    /// anywhere downstream is grouped by their ids — a reader would be building a legend for a
    /// dimension nothing is ever split by. The three kinds here are exactly the three ids that
    /// <c>ExecutionLogScope</c> stamps on every execution record.
    /// </para>
    /// <para>
    /// <b>Processors come from the snapshot, not from the step rows.</b> Several steps share one
    /// processor, and emitting per step would repeat the same pair as many times as it is
    /// referenced. The snapshot's dictionary is already unique by id.
    /// </para>
    /// <para>
    /// <b>A STEP ALSO CARRIES ITS WORKFLOW'S ID, AND A PROCESSOR DELIBERATELY DOES NOT.</b> The Step
    /// control on the dashboard is chained under the Workflow control, which means Kibana narrows
    /// its options to records matching the selected <c>WorkflowId</c>. Without that id on the step's
    /// naming record, the only records left to match are executions — and the list collapses to
    /// steps that have already RUN, which is precisely the guarantee these records exist to provide.
    /// Measured before the id was added: selecting a workflow took the Step list from 40 options to
    /// the 10 that had run.
    /// <br/>
    /// A processor is not chained under anything — there is no Processor control — and it is
    /// genuinely shared across workflows, so stamping one workflow on it would pick an arbitrary
    /// owner and multiply the rows for a reader that only ever needs id to name.
    /// </para>
    /// </summary>
    private static IEnumerable<(string Kind, Dictionary<string, object> Scope, string Name, string Version)> NameablesOf(
        WorkflowGraphSnapshot snapshot)
    {
        foreach (var w in snapshot.Workflows.Values)
            yield return ("workflow",
                new Dictionary<string, object> { [ExecutionLogScope.WorkflowId] = w.Id.ToString("D") },
                w.Name, w.Version);

        // The loader is called with exactly one workflow id, so every step in this snapshot belongs
        // to that workflow and the owner is not a guess.
        foreach (var workflowId in snapshot.Workflows.Keys)
            foreach (var s in snapshot.Steps.Values)
                yield return ("step",
                    new Dictionary<string, object>
                    {
                        [ExecutionLogScope.StepId]     = s.Id.ToString("D"),
                        [ExecutionLogScope.WorkflowId] = workflowId.ToString("D"),
                    },
                    s.Name, s.Version);

        foreach (var p in snapshot.Processors.Values)
            yield return ("processor",
                new Dictionary<string, object> { [ExecutionLogScope.ProcessorId] = p.Id.ToString("D") },
                p.Name, p.Version);
    }

    /// <summary>
    /// Flattens the validated snapshot into the definition that travels on the wire.
    /// <para>
    /// Processors and schemas are left behind: they exist to feed the validators that have already
    /// run, and the projection never reads them. The assignment payload is resolved here, while both
    /// sides of that binding are in hand, so the consumer never has to know the junction exists.
    /// </para>
    /// </summary>
    private static WorkflowL1 ToDefinition(WorkflowGraphSnapshot snapshot, Guid workflowId)
    {
        var workflow = snapshot.Workflows[workflowId];

        var steps = snapshot.Steps.Values.Select(step => new StepL1(
            StepId: step.Id,
            EntryCondition: (int)step.EntryCondition,
            ProcessorId: step.ProcessorId,
            // A step need not carry an assignment: a workflow may hold steps with no payload binding,
            // and an unbound step projects an empty payload rather than a null the reader must guard.
            Payload: snapshot.Assignments.Values
                .FirstOrDefault(a => a.StepId == step.Id)?.Payload ?? string.Empty,
            NextStepIds: step.NextStepIds ?? new List<Guid>())).ToList();

        // Resolved here, while both sides of the junction are in hand, so the consumer never has to
        // know the junction exists — the same reason the assignment payload is resolved above.
        //
        // A cache id naming no loaded row is skipped rather than throwing. The foreign key makes
        // that unreachable, and turning an impossible state into a failed start would refuse a
        // workflow for a reason no operator could act on.
        var caches = (workflow.CacheIds ?? new List<Guid>())
            .Select(id => snapshot.Caches.TryGetValue(id, out var dto) ? dto : null)
            .Where(dto => dto is not null)
            .Select(dto => new CacheL1(
                dto!.Root,
                JsonSerializer.Deserialize<Dictionary<string, string>>(dto.Items)
                    ?? new Dictionary<string, string>()))
            .ToList();

        return new WorkflowL1(
            WorkflowId: workflowId,
            EntryStepIds: workflow.EntryStepIds ?? new List<Guid>(),
            Cron: workflow.CronExpression,
            Steps: steps,
            Caches: caches);
    }

    /// <summary>
    /// Exposes <see cref="ToDefinition"/> to the test assembly. The method is static and pure, and
    /// reaching it through a constructed service would mean supplying eight dependencies none of
    /// which it touches.
    /// </summary>
    internal static WorkflowL1 ToDefinitionForTests(WorkflowGraphSnapshot snapshot, Guid workflowId)
        => ToDefinition(snapshot, workflowId);

    /// <summary>
    /// Rejects an empty id, then verifies the workflow row exists. An empty id raises a validation
    /// exception, which becomes a 400; an unresolved id raises <see cref="NotFoundException"/>, which
    /// becomes a 404. Existence is a single row probe rather than a materialized entity.
    /// </summary>
    private async Task ExistenceCheckAsync(Guid workflowId, CancellationToken ct)
    {
        GuardNotEmpty(workflowId);

        var exists = await _db.Set<WorkflowEntity>()
            .AsNoTracking()
            .AnyAsync(w => w.Id == workflowId, ct);

        if (!exists)
        {
            throw new NotFoundException(nameof(WorkflowEntity), workflowId);
        }
    }

    /// <summary>
    /// The one input rule left now that the body carries a single id: it must not be
    /// <see cref="Guid.Empty"/>. It throws the same exception type the validation pipeline uses, so
    /// the 400 response shape is unchanged.
    /// </summary>
    private static void GuardNotEmpty(Guid workflowId)
    {
        if (workflowId == Guid.Empty)
        {
            throw new ValidationException(new[]
            {
                new ValidationFailure(nameof(workflowId), "WorkflowId must not be Guid.Empty."),
            });
        }
    }
}
