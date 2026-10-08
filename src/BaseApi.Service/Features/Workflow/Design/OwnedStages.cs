using BaseApi.Core.Mapping;
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Assignment;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>
/// Stage 6: this workflow's assignments (owned: the studio gives every new one a new id). Create inserts
/// a row with the design's id (stage 7 links it); update changes it in place after the conflict check;
/// delete unlinks it from this workflow and deletes the row in one save (an assignment another workflow
/// still lists is refused by its restrict foreign key, and that is this assignment's error).
/// </summary>
internal sealed class AssignmentStage : IDesignStage
{
    private readonly BaseDbContext _db;
    private readonly IValidator<AssignmentCreateDto> _createValidator;
    private readonly IValidator<AssignmentUpdateDto> _updateValidator;
    private readonly IEntityMapper<AssignmentEntity, AssignmentCreateDto, AssignmentUpdateDto, AssignmentReadDto> _mapper;

    public AssignmentStage(BaseDbContext db, IValidator<AssignmentCreateDto> createValidator, IValidator<AssignmentUpdateDto> updateValidator,
        IEntityMapper<AssignmentEntity, AssignmentCreateDto, AssignmentUpdateDto, AssignmentReadDto> mapper)
    {
        _db = db;
        _createValidator = createValidator;
        _updateValidator = updateValidator;
        _mapper = mapper;
    }

    public async Task RunAsync(DesignRun run, CancellationToken ct)
    {
        foreach (var a in run.Request.Assignments ?? [])
        {
            switch (a.Op)
            {
                case "create":
                    if (await run.UnitAsync("assignment", a.Id, "assignments", () => CreateAsync(a, ct), ct))
                        run.CreatedAssignments.Add(a.Id);
                    break;
                case "update":
                    await run.UnitAsync("assignment", a.Id, "assignments", () => UpdateAsync(a, ct), ct);
                    break;
                default:
                    if (await run.UnitAsync("assignment", a.Id, "assignments", () => DeleteAsync(run.WorkflowId, a, ct), ct))
                        run.DeletedAssignments.Add(a.Id);
                    break;
            }
        }
    }

    private async Task<List<FieldError>> CreateAsync(DesignAssignmentDto a, CancellationToken ct)
    {
        var errors = new List<FieldError>();
        var fields = DesignFields.Apply(new AssignmentUpdateDto("", "", null, a.StepId, ""), a.Fields, errors);
        if (errors.Count > 0) return errors;
        var dto = new AssignmentCreateDto(fields.Name, fields.Version, fields.Description, a.StepId, fields.Payload);
        var problems = DesignFields.Failures(await _createValidator.ValidateAsync(dto, ct));
        if (problems.Count > 0) return problems;
        var entity = _mapper.ToEntity(dto);
        entity.Id = a.Id;
        _db.Add(entity);
        return problems;
    }

    private async Task<List<FieldError>> UpdateAsync(DesignAssignmentDto a, CancellationToken ct)
    {
        var entity = await _db.Set<AssignmentEntity>().FirstOrDefaultAsync(x => x.Id == a.Id, ct);
        if (entity is null) return [new FieldError(null, "This assignment no longer exists.")];
        if (DesignRun.IsStale(entity.UpdatedAt, a.UpdatedAt)) return [new FieldError(null, DesignRun.Conflict)];
        var errors = new List<FieldError>();
        // the step an assignment belongs to is never edited here
        var dto = DesignFields.Apply(DesignFields.UpdateOf(entity), a.Fields, errors) with { StepId = entity.StepId };
        if (errors.Count > 0) return errors;
        var problems = DesignFields.Failures(await _updateValidator.ValidateAsync(dto, ct));
        if (problems.Count > 0) return problems;
        _mapper.Update(dto, entity);
        return problems;
    }

    private async Task<List<FieldError>> DeleteAsync(Guid workflowId, DesignAssignmentDto a, CancellationToken ct)
    {
        var entity = await _db.Set<AssignmentEntity>().FirstOrDefaultAsync(x => x.Id == a.Id, ct);
        if (entity is null) return []; // already gone: what was asked
        if (DesignRun.IsStale(entity.UpdatedAt, a.UpdatedAt)) return [new FieldError(null, DesignRun.Conflict)];
        // unlink, then delete the row: one save, ordered by EF from the foreign keys
        var links = await _db.Set<WorkflowAssignments>().Where(j => j.WorkflowId == workflowId && j.AssignmentId == a.Id).ToListAsync(ct);
        _db.RemoveRange(links);
        _db.Remove(entity);
        return [];
    }
}

/// <summary>
/// Stage 7: the workflow's fields, entry steps and caches, and the assignment links stage 6 produced.
/// Owned: checked against the stamp the designer loaded. "At least one entry step" is the workflow
/// CRUD's own rule. Runs only when something of the workflow changed.
/// </summary>
internal sealed class WorkflowStage : IDesignStage
{
    private readonly BaseDbContext _db;
    private readonly IValidator<WorkflowUpdateDto> _validator;
    private readonly IEntityMapper<WorkflowEntity, WorkflowCreateDto, WorkflowUpdateDto, WorkflowReadDto> _mapper;

    public WorkflowStage(BaseDbContext db, IValidator<WorkflowUpdateDto> validator,
        IEntityMapper<WorkflowEntity, WorkflowCreateDto, WorkflowUpdateDto, WorkflowReadDto> mapper)
    {
        _db = db;
        _validator = validator;
        _mapper = mapper;
    }

    public async Task RunAsync(DesignRun run, CancellationToken ct)
    {
        var w = run.Request.Workflow;
        var linksChanged = run.CreatedAssignments.Count > 0 || run.DeletedAssignments.Count > 0;
        var changed = w is not null && (w.Fields is { Count: > 0 } || w.EntryStepIds is not null || w.CacheIds is not null);
        if (!changed && !linksChanged) return;

        await run.UnitAsync("workflow", run.WorkflowId, "workflow", async () =>
        {
            var entity = await _db.Set<WorkflowEntity>().FirstOrDefaultAsync(x => x.Id == run.WorkflowId, ct);
            if (entity is null) return [new FieldError(null, "This workflow no longer exists.")];
            if (DesignRun.IsStale(entity.UpdatedAt, w?.UpdatedAt)) return [new FieldError(null, DesignRun.Conflict)];

            var entry = w?.EntryStepIds ?? await _db.Set<WorkflowEntrySteps>()
                .Where(j => j.WorkflowId == run.WorkflowId).Select(j => j.StepId).ToListAsync(ct);
            var caches = w?.CacheIds ?? await _db.Set<WorkflowCaches>()
                .Where(j => j.WorkflowId == run.WorkflowId).Select(j => j.CacheId).ToListAsync(ct);
            var linked = await _db.Set<WorkflowAssignments>()
                .Where(j => j.WorkflowId == run.WorkflowId).Select(j => j.AssignmentId).ToListAsync(ct);
            var assignments = linked.Where(id => !run.DeletedAssignments.Contains(id))
                .Concat(run.CreatedAssignments.Where(id => !linked.Contains(id))).ToList();

            var errors = new List<FieldError>();
            var dto = DesignFields.Apply(
                new WorkflowUpdateDto(entity.Name, entity.Version, entity.Description, entry, assignments, caches, entity.CronExpression),
                w?.Fields, errors);
            if (errors.Count > 0) return errors;
            var problems = DesignFields.Failures(await _validator.ValidateAsync(dto, ct));
            if (problems.Count > 0) return problems;
            _mapper.Update(dto, entity);
            // entry, cache and assignment changes are junction-only: force the stamp, as the graph saver does
            _db.Entry(entity).Property(e => e.UpdatedAt).IsModified = true;
            await WorkflowJunctions.SyncAsync(_db, run.WorkflowId, dto.EntryStepIds, dto.AssignmentIds, dto.CacheIds, replaceExisting: true, ct);
            return problems;
        }, ct);
    }
}
