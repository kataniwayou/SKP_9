using BaseApi.Core.Mapping;
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Orchestration;
using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Schema;
using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace BaseApi.Service.Features.Orchestration.Loading;

/// <summary>
/// Builds the in-memory graph the validators run against, from the database.
/// <para>
/// The logger is typed for <see cref="WorkflowGraphSnapshot"/> rather than for this loader, because
/// it is handed straight to the snapshot's constructor — the snapshot owns its own disposal log line.
/// </para>
/// </summary>
internal sealed class WorkflowGraphLoader : IWorkflowGraphLoader
{
    private readonly BaseDbContext _db;
    private readonly ILogger<WorkflowGraphSnapshot> _logger;
    private readonly IEntityMapper<SchemaEntity,     SchemaCreateDto,     SchemaUpdateDto,     SchemaReadDto>     _schemaMapper;
    private readonly IEntityMapper<ProcessorEntity,  ProcessorCreateDto,  ProcessorUpdateDto,  ProcessorReadDto>  _processorMapper;
    private readonly IEntityMapper<StepEntity,       StepCreateDto,       StepUpdateDto,       StepReadDto>       _stepMapper;
    private readonly IEntityMapper<AssignmentEntity, AssignmentCreateDto, AssignmentUpdateDto, AssignmentReadDto> _assignmentMapper;
    private readonly IEntityMapper<WorkflowEntity,   WorkflowCreateDto,   WorkflowUpdateDto,   WorkflowReadDto>   _workflowMapper;

    public WorkflowGraphLoader(
        BaseDbContext db,
        ILogger<WorkflowGraphSnapshot> logger,
        IEntityMapper<SchemaEntity,     SchemaCreateDto,     SchemaUpdateDto,     SchemaReadDto>     schemaMapper,
        IEntityMapper<ProcessorEntity,  ProcessorCreateDto,  ProcessorUpdateDto,  ProcessorReadDto>  processorMapper,
        IEntityMapper<StepEntity,       StepCreateDto,       StepUpdateDto,       StepReadDto>       stepMapper,
        IEntityMapper<AssignmentEntity, AssignmentCreateDto, AssignmentUpdateDto, AssignmentReadDto> assignmentMapper,
        IEntityMapper<WorkflowEntity,   WorkflowCreateDto,   WorkflowUpdateDto,   WorkflowReadDto>   workflowMapper)
    {
        _db               = db               ?? throw new ArgumentNullException(nameof(db));
        _logger           = logger           ?? throw new ArgumentNullException(nameof(logger));
        _schemaMapper     = schemaMapper     ?? throw new ArgumentNullException(nameof(schemaMapper));
        _processorMapper  = processorMapper  ?? throw new ArgumentNullException(nameof(processorMapper));
        _stepMapper       = stepMapper       ?? throw new ArgumentNullException(nameof(stepMapper));
        _assignmentMapper = assignmentMapper ?? throw new ArgumentNullException(nameof(assignmentMapper));
        _workflowMapper   = workflowMapper   ?? throw new ArgumentNullException(nameof(workflowMapper));
    }

    /// <summary>
    /// Builds the graph in four stages: load the requested workflows and their junction edges; walk
    /// the reachable step graph breadth-first over the next-step junction; batch-load the dependent
    /// processors, schemas and assignments; then map every entity through its mapper and enrich the
    /// junction-backed collections. Every read is a no-tracking batch query against the context
    /// directly rather than through the repository. The snapshot is constructed with the injected
    /// logger so its own disposal emits the log line.
    /// </summary>
    public async Task<WorkflowGraphSnapshot> LoadL1Async(IReadOnlyList<Guid> workflowIds, CancellationToken ct)
    {
        // Stage 1 — the workflows plus their junction edges: entry steps and assignments.
        var workflows = await _db.Set<WorkflowEntity>().AsNoTracking()
            .Where(w => workflowIds.Contains(w.Id)).ToListAsync(ct);

        var entryRows = await _db.Set<WorkflowEntrySteps>().AsNoTracking()
            .Where(j => workflowIds.Contains(j.WorkflowId)).ToListAsync(ct);
        var entryLookup = entryRows.GroupBy(j => j.WorkflowId)
            .ToDictionary(g => g.Key, g => g.Select(j => j.StepId).ToList());

        var wfAssignmentRows = await _db.Set<WorkflowAssignments>().AsNoTracking()
            .Where(j => workflowIds.Contains(j.WorkflowId)).ToListAsync(ct);
        var assignmentLookup = wfAssignmentRows.GroupBy(j => j.WorkflowId)
            .ToDictionary(g => g.Key, g => g.Select(j => j.AssignmentId).ToList());

        // Stage 2 — breadth-first step traversal over the next-step junction, terminating on cycles.
        var allEntryStepIds = entryLookup.Values.SelectMany(x => x).Distinct().ToList();
        var (stepEntities, nextStepLookup) = await LoadStepsBreadthFirstAsync(allEntryStepIds, ct);

        // Stage 3 — batched dependents, now that every step id is known.
        var processorIds = stepEntities.Select(s => s.ProcessorId).Distinct().ToList();
        var processors = await _db.Set<ProcessorEntity>().AsNoTracking()
            .Where(p => processorIds.Contains(p.Id)).ToListAsync(ct);

        var schemaIds = processors
            .SelectMany(p => new[] { p.InputSchemaId, p.OutputSchemaId, p.ConfigSchemaId })
            .Where(id => id.HasValue).Select(id => id!.Value).Distinct().ToList();
        var schemas = await _db.Set<SchemaEntity>().AsNoTracking()
            .Where(s => schemaIds.Contains(s.Id)).ToListAsync(ct);

        var assignmentIds = assignmentLookup.Values.SelectMany(x => x).Distinct().ToList();
        var assignments = await _db.Set<AssignmentEntity>().AsNoTracking()
            .Where(a => assignmentIds.Contains(a.Id)).ToListAsync(ct);

        // Stage 4 — map each entity, then enrich the collections that live only on the junctions.
        var snapshot = new WorkflowGraphSnapshot(_logger);

        foreach (var s in schemas)     snapshot.Schemas[s.Id]     = _schemaMapper.ToRead(s);
        foreach (var p in processors)  snapshot.Processors[p.Id]  = _processorMapper.ToRead(p);
        foreach (var a in assignments) snapshot.Assignments[a.Id] = _assignmentMapper.ToRead(a);

        foreach (var st in stepEntities)
        {
            var dto = _stepMapper.ToRead(st);                                  // next-step ids come back null
            var children = nextStepLookup.GetValueOrDefault(st.Id) ?? new List<Guid>();
            snapshot.Steps[st.Id] = dto with { NextStepIds = children };
        }

        foreach (var wf in workflows)
        {
            var dto = _workflowMapper.ToRead(wf);                              // both collections come back null
            var entry = entryLookup.GetValueOrDefault(wf.Id) ?? new List<Guid>();
            var asg   = assignmentLookup.GetValueOrDefault(wf.Id) ?? new List<Guid>();
            snapshot.Workflows[wf.Id] = dto with { EntryStepIds = entry, AssignmentIds = asg };
        }

        return snapshot;
    }

    /// <summary>
    /// Iterative wave-by-wave breadth-first traversal over the next-step junction. No recursion, and
    /// no eager loading, since there are no navigation properties between entities. The visited guard
    /// is a plain list keyed on step id, and skipping already-visited ids before enqueuing the next
    /// wave is what makes loading terminate on a cyclic graph — which matters, because the cycle
    /// validator only gets to report the cycle if the load returns at all. Multi-child fan-out is
    /// honoured: each wave collects every successor of the current wave, not just the first. Returns
    /// the loaded entities alongside the per-step children lookup used to enrich the read DTOs.
    /// </summary>
    private async Task<(List<StepEntity> Steps, Dictionary<Guid, List<Guid>> NextStepLookup)>
        LoadStepsBreadthFirstAsync(IReadOnlyList<Guid> entryStepIds, CancellationToken ct)
    {
        var visited = new List<Guid>();
        var loadedSteps = new List<StepEntity>();
        var nextStepLookup = new Dictionary<Guid, List<Guid>>();

        var currentWave = entryStepIds.Where(id => id != Guid.Empty).Distinct().ToList();

        while (currentWave.Count > 0)
        {
            // Load only the ids not already visited — the cycle and duplicate guard.
            var toLoad = currentWave.Where(id => !visited.Contains(id)).Distinct().ToList();
            if (toLoad.Count == 0) break;

            var stepEntities = await _db.Set<StepEntity>().AsNoTracking()
                .Where(s => toLoad.Contains(s.Id)).ToListAsync(ct);
            loadedSteps.AddRange(stepEntities);

            var loadedIds = stepEntities.Select(s => s.Id).ToList();
            foreach (var id in loadedIds) visited.Add(id);

            // Discover children through the junction: the children of a step are the rows keyed by it.
            var nextRows = await _db.Set<StepNextSteps>().AsNoTracking()
                .Where(j => loadedIds.Contains(j.StepId)).ToListAsync(ct);

            var waveLookup = nextRows.GroupBy(j => j.StepId)
                .ToDictionary(g => g.Key, g => g.Select(j => j.NextStepId).ToList());
            foreach (var kvp in waveLookup) nextStepLookup[kvp.Key] = kvp.Value;

            // The next wave is every not-yet-visited child, across all of them.
            currentWave = nextRows.Select(j => j.NextStepId)
                .Where(id => !visited.Contains(id))
                .Distinct().ToList();
        }

        return (loadedSteps, nextStepLookup);
    }
}
