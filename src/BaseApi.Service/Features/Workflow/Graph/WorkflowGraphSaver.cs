using BaseApi.Core.Mapping;
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Step;
using FluentValidation;
using FluentValidation.Results;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow.Graph;

/// <summary>
/// Creates or replaces a workflow's whole graph in one commit, in the spec's order: validate,
/// check concurrency, apply schema edits, write steps, resolve assignments, write the workflow and
/// its layout, then one <c>SaveChangesAsync</c>.
/// <para>
/// <b>One save, not a transaction around several.</b> EF orders the inserts and deletes of a
/// single save by the foreign keys in the model -- step rows before the wires between them, a new
/// schema before the processor that points at it, a junction delete before the orphaned assignment
/// -- which is what the spec's "rows, then wires" two passes need, and a single save is atomic. A
/// Postgres FK violation therefore rolls back everything and surfaces as the existing 422.
/// </para>
/// <para>
/// <b>Nothing here judges the design.</b> No cycle, schema-edge, payload or liveness check: those
/// are start checks. The validators run only the field rules the CRUD endpoints already enforce.
/// </para>
/// </summary>
internal sealed class WorkflowGraphSaver : IWorkflowGraphSaver
{
    private readonly BaseDbContext _db;
    private readonly IWorkflowGraphReader _reader;
    private readonly IValidator<WorkflowUpdateDto> _workflowValidator;
    private readonly IValidator<StepCreateDto> _stepCreateValidator;
    private readonly IValidator<StepUpdateDto> _stepUpdateValidator;
    private readonly IEntityMapper<WorkflowEntity, WorkflowCreateDto, WorkflowUpdateDto, WorkflowReadDto> _workflowMapper;
    private readonly IEntityMapper<StepEntity, StepCreateDto, StepUpdateDto, StepReadDto> _stepMapper;
    private readonly GraphAssignmentResolver _assignments;
    private readonly GraphSchemaEditor _schemas;

    public WorkflowGraphSaver(
        BaseDbContext db,
        IWorkflowGraphReader reader,
        IValidator<WorkflowUpdateDto> workflowValidator,
        IValidator<StepCreateDto> stepCreateValidator,
        IValidator<StepUpdateDto> stepUpdateValidator,
        IEntityMapper<WorkflowEntity, WorkflowCreateDto, WorkflowUpdateDto, WorkflowReadDto> workflowMapper,
        IEntityMapper<StepEntity, StepCreateDto, StepUpdateDto, StepReadDto> stepMapper,
        GraphAssignmentResolver assignments,
        GraphSchemaEditor schemas)
    {
        _db = db;
        _reader = reader;
        _workflowValidator = workflowValidator;
        _stepCreateValidator = stepCreateValidator;
        _stepUpdateValidator = stepUpdateValidator;
        _workflowMapper = workflowMapper;
        _stepMapper = stepMapper;
        _assignments = assignments;
        _schemas = schemas;
    }

    public async Task<WorkflowGraphDto> SaveAsync(Guid workflowId, GraphSaveRequest request, CancellationToken ct)
    {
        var wf = request.Workflow;
        var steps = request.Steps ?? [];
        var intents = request.Assignments ?? [];
        var edits = request.SchemaEdits ?? [];

        // ---- 1. Validate: the request's own shape, then the existing validators. -----------------
        var failures = new List<ValidationFailure>();

        if (workflowId == Guid.Empty)
            failures.Add(new ValidationFailure("WorkflowId", "The workflow id must not be Guid.Empty."));

        if (request.Layout is { } layout && WorkflowLayout.Validate(layout) is { } layoutError)
            failures.Add(new ValidationFailure(nameof(GraphSaveRequest.Layout), layoutError));

        if (steps.Select(s => s.Id).Distinct().Count() != steps.Count)
            failures.Add(new ValidationFailure(nameof(GraphSaveRequest.Steps), "Each step may appear once."));

        if (steps.Any(s => s.Id == Guid.Empty))
            failures.Add(new ValidationFailure(nameof(GraphSaveRequest.Steps), "A step id must not be Guid.Empty."));

        if (intents.Select(i => i.StepId).Distinct().Count() != intents.Count)
            failures.Add(new ValidationFailure(nameof(GraphSaveRequest.Assignments), "Each step may have one assignment intent."));

        var workflowDto = new WorkflowUpdateDto(
            wf.Name, wf.Version, wf.Description, wf.EntryStepIds, null, wf.CacheIds, wf.CronExpression);
        failures.AddRange((await _workflowValidator.ValidateAsync(workflowDto, ct)).Errors);

        var stepIds = steps.Select(s => s.Id).ToList();
        var storedSteps = await _db.Set<StepEntity>()
            .Where(s => stepIds.Contains(s.Id))
            .ToDictionaryAsync(s => s.Id, ct);

        foreach (var s in steps)
        {
            var result = storedSteps.ContainsKey(s.Id)
                ? await _stepUpdateValidator.ValidateAsync(ToUpdate(s), ct)
                : await _stepCreateValidator.ValidateAsync(ToCreate(s), ct);
            failures.AddRange(result.Errors.Select(e =>
                new ValidationFailure($"Steps[{s.Id}].{e.PropertyName}", e.ErrorMessage)));
        }

        if (failures.Count > 0)
            throw new ValidationException(failures);

        // ---- 2. Concurrency: 409 before anything is staged. --------------------------------------
        var storedWorkflow = await _db.Set<WorkflowEntity>().FirstOrDefaultAsync(w => w.Id == workflowId, ct);

        if (storedWorkflow is null ? wf.UpdatedAt is not null : IsStale(storedWorkflow.UpdatedAt, wf.UpdatedAt))
            throw new GraphConflictException("workflow", workflowId);

        foreach (var s in steps)
        {
            var stale = storedSteps.TryGetValue(s.Id, out var stored)
                ? IsStale(stored.UpdatedAt, s.UpdatedAt)
                : s.UpdatedAt is not null;     // claimed to exist, but it is gone
            if (stale)
                throw new GraphConflictException("step", s.Id);
        }

        // ---- 3. Schema edits: a new schema row, then re-point the slot. --------------------------
        await _schemas.ApplyAsync(edits, ct);

        // ---- 4. Steps: rows and wires, ordered by EF at save time. -------------------------------
        foreach (var s in steps)
        {
            if (storedSteps.TryGetValue(s.Id, out var stored))
            {
                _stepMapper.Update(ToUpdate(s), stored);
                // Wires live only in StepNextSteps, so a wiring-only edit leaves the row Unchanged and
                // UpdatedAt/xmin would not move. Force the stamp so the next stale save gets a 409.
                _db.Entry(stored).State = EntityState.Modified;
                await StepJunctions.SyncNextStepsAsync(_db, s.Id, s.NextStepIds, replaceExisting: true, ct);
            }
            else
            {
                var entity = _stepMapper.ToEntity(ToCreate(s));
                entity.Id = s.Id;
                _db.Add(entity);
                await StepJunctions.SyncNextStepsAsync(_db, s.Id, s.NextStepIds, replaceExisting: false, ct);
            }
        }

        // ---- 5. Assignments: the workflow's final assignment set. --------------------------------
        List<Guid> assignmentIds = intents.Count > 0
            ? await _assignments.ResolveAsync(workflowId, wf.Name, intents, ct)
            : await _db.Set<WorkflowAssignments>()
                .Where(j => j.WorkflowId == workflowId)
                .Select(j => j.AssignmentId)
                .ToListAsync(ct);

        // ---- 6. The workflow row, its junctions and its layout, then one save. -------------------
        if (storedWorkflow is null)
        {
            storedWorkflow = _workflowMapper.ToEntity(new WorkflowCreateDto(
                wf.Name, wf.Version, wf.Description, wf.EntryStepIds, assignmentIds, wf.CacheIds, wf.CronExpression));
            storedWorkflow.Id = workflowId;
            _db.Add(storedWorkflow);
        }
        else
        {
            _workflowMapper.Update(workflowDto with { AssignmentIds = assignmentIds }, storedWorkflow);
            // Same reason as steps: entry/cache/assignment changes are junction-only, so force the stamp.
            _db.Entry(storedWorkflow).State = EntityState.Modified;
        }

        if (request.Layout is { } newLayout)
            storedWorkflow.Layout = newLayout.GetRawText();

        await WorkflowJunctions.SyncAsync(
            _db, workflowId, wf.EntryStepIds, assignmentIds, wf.CacheIds,
            replaceExisting: _db.Entry(storedWorkflow).State != EntityState.Added, ct);

        await _db.SaveChangesAsync(ct);

        return await _reader.ReadAsync(workflowId, ct);
    }

    /// <summary>Stale when the stored row is newer than what the client loaded, or the client sent no stamp.</summary>
    private static bool IsStale(DateTime stored, DateTime? loaded) => loaded is null || stored > loaded.Value;

    private static StepCreateDto ToCreate(GraphStepDto s) =>
        new(s.Name, s.Version, s.Description, s.ProcessorId, s.NextStepIds, s.EntryCondition);

    private static StepUpdateDto ToUpdate(GraphStepDto s) =>
        new(s.Name, s.Version, s.Description, s.ProcessorId, s.NextStepIds, s.EntryCondition);
}
