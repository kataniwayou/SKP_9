using BaseApi.Core.Exceptions;
using BaseApi.Core.Messaging;
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Orchestration.Loading;
using BaseApi.Service.Features.Orchestration.Validation;
using BaseApi.Service.Features.Workflow;
using FluentValidation;
using FluentValidation.Results;
using Messaging.Contracts;
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
        _cycleDetector.Validate(snapshot);
        _schemaEdgeValidator.Validate(snapshot);
        _payloadConfigSchemaValidator.Validate(snapshot);

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

        var definition = ToDefinition(snapshot, workflowId);

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

        return new WorkflowL1(
            WorkflowId: workflowId,
            EntryStepIds: workflow.EntryStepIds ?? new List<Guid>(),
            Cron: workflow.CronExpression,
            Steps: steps);
    }

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
