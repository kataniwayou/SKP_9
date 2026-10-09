using BaseApi.Core.Mapping;
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Cache;
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
        var assignments = run.Request.Assignments ?? [];
        run.BeginStage("assignments", assignments.Count, assignments.Count == 1 ? "assignment to create, update or delete" : "assignments to create, update or delete");
        var steps = await DesignLogText.StepNamesAsync(_db, assignments.Select(a => a.StepId), ct);
        var ids = assignments.Select(a => a.Id).ToList();
        var stored = await _db.Set<AssignmentEntity>().AsNoTracking().Where(x => ids.Contains(x.Id))
            .Select(x => new { x.Id, x.Name }).ToDictionaryAsync(x => x.Id, x => x.Name, ct);
        foreach (var a in assignments)
        {
            var name = stored.GetValueOrDefault(a.Id) ?? Text(a.Fields, "name");
            if (name is not null) run.AssignmentNames[a.Id] = name;
            run.Label(a.Id, name is null ? $"assignment on step '{steps[a.StepId]}'" : $"assignment '{name}' on step '{steps[a.StepId]}'");
        }
        foreach (var a in assignments)
        {
            string? change = null;
            switch (a.Op)
            {
                case "create":
                    if (await run.UnitAsync("assignment", a.Id, "assignments", () => CreateAsync(a, ct), ct))
                    {
                        run.CreatedAssignments.Add(a.Id);
                        run.Changed("assignment", a.Id, "created", "created (linked to the workflow in the workflow stage)");
                    }
                    break;
                case "update":
                    if (await run.UnitAsync("assignment", a.Id, "assignments", () => UpdateAsync(a, c => change = c, ct), ct))
                    {
                        if (change is null) run.Unchanged(a.Id);
                        else run.Changed("assignment", a.Id, "updated", change);
                    }
                    break;
                default:
                    var gone = false;
                    var unlinked = false;
                    if (await run.UnitAsync("assignment", a.Id, "assignments", () => DeleteAsync(run.WorkflowId, a, g => gone = g, u => unlinked = u, ct), ct))
                    {
                        run.DeletedAssignments.Add(a.Id);
                        if (unlinked) run.UnlinkedAssignments.Add(a.Id);
                        if (gone) run.Unchanged(a.Id);
                        else run.Changed("assignment", a.Id, "deleted", "unlinked from this workflow and deleted");
                    }
                    break;
            }
        }
        run.EndStage();
    }

    /// <summary>A text field of the design, when it is one (for naming a new assignment in the log).</summary>
    private static string? Text(Dictionary<string, System.Text.Json.JsonElement>? fields, string key) =>
        fields is not null && fields.TryGetValue(key, out var v) && v.ValueKind == System.Text.Json.JsonValueKind.String ? v.GetString() : null;

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

    private async Task<List<FieldError>> UpdateAsync(DesignAssignmentDto a, Action<string?> changed, CancellationToken ct)
    {
        var entity = await _db.Set<AssignmentEntity>().FirstOrDefaultAsync(x => x.Id == a.Id, ct);
        if (entity is null) return [new FieldError(null, "This assignment no longer exists.")];
        if (DesignRun.IsStale(entity.UpdatedAt, a.UpdatedAt)) return [new FieldError(null, DesignRun.Conflict)];
        var errors = new List<FieldError>();
        // the step an assignment belongs to is never edited here
        var before = DesignFields.UpdateOf(entity);
        var dto = DesignFields.Apply(before, a.Fields, errors) with { StepId = entity.StepId };
        if (errors.Count > 0) return errors;
        var problems = DesignFields.Failures(await _updateValidator.ValidateAsync(dto, ct));
        if (problems.Count > 0) return problems;
        _mapper.Update(dto, entity);
        changed(DesignLogText.Join(DesignLogText.Fields(
            ("name", before.Name, dto.Name), ("version", before.Version, dto.Version), ("description", before.Description, dto.Description),
            ("payload", before.Payload, dto.Payload))));
        return problems;
    }

    private async Task<List<FieldError>> DeleteAsync(Guid workflowId, DesignAssignmentDto a, Action<bool> gone, Action<bool> unlinked, CancellationToken ct)
    {
        var entity = await _db.Set<AssignmentEntity>().FirstOrDefaultAsync(x => x.Id == a.Id, ct);
        gone(entity is null);
        if (entity is null) return []; // already gone: what was asked
        if (DesignRun.IsStale(entity.UpdatedAt, a.UpdatedAt)) return [new FieldError(null, DesignRun.Conflict)];
        // unlink, then delete the row: one save, ordered by EF from the foreign keys
        var links = await _db.Set<WorkflowAssignments>().Where(j => j.WorkflowId == workflowId && j.AssignmentId == a.Id).ToListAsync(ct);
        unlinked(links.Count > 0);
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
        run.BeginStage("workflow", changed || linksChanged ? 1 : 0, "workflow to update");
        if (!changed && !linksChanged)
        {
            run.EndStage();
            return;
        }

        string? change = null;
        var applied = await run.UnitAsync("workflow", run.WorkflowId, "workflow", async () =>
        {
            var entity = await _db.Set<WorkflowEntity>().FirstOrDefaultAsync(x => x.Id == run.WorkflowId, ct);
            if (entity is null) return [new FieldError(null, "This workflow no longer exists.")];
            run.Label(run.WorkflowId, $"workflow '{entity.Name}'");
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
            var before = (entity.Name, entity.Version, entity.Description, entity.CronExpression);
            var oldEntry = await _db.Set<WorkflowEntrySteps>().AsNoTracking()
                .Where(j => j.WorkflowId == run.WorkflowId).Select(j => j.StepId).ToListAsync(ct);
            var oldCaches = await _db.Set<WorkflowCaches>().AsNoTracking()
                .Where(j => j.WorkflowId == run.WorkflowId).Select(j => j.CacheId).ToListAsync(ct);
            _mapper.Update(dto, entity);
            // entry, cache and assignment changes are junction-only: force the stamp, as the graph saver does
            _db.Entry(entity).Property(e => e.UpdatedAt).IsModified = true;
            await WorkflowJunctions.SyncAsync(_db, run.WorkflowId, dto.EntryStepIds, dto.AssignmentIds, dto.CacheIds, replaceExisting: true, ct);
            // what the workflow listed before this save: what it lists now, and what the assignment stage unlinked
            change = await DescribeAsync(before, dto, oldEntry, oldCaches, [.. linked, .. run.UnlinkedAssignments.Where(id => !linked.Contains(id))], run.AssignmentNames, ct);
            return problems;
        }, ct);
        // the stage always writes the workflow's stamp, so an applied unit is an update even when nothing else differs
        if (applied) run.Changed("workflow", run.WorkflowId, "updated", change ?? "its stamp moved; no field or list changed");
        run.EndStage();
    }

    /// <summary>What the workflow stage wrote: its changed fields, and how its entry steps, caches and assignment links changed.</summary>
    private async Task<string?> DescribeAsync(
        (string Name, string Version, string? Description, string? CronExpression) before, WorkflowUpdateDto dto,
        List<Guid> oldEntry, List<Guid> oldCaches, List<Guid> oldAssignments, IReadOnlyDictionary<Guid, string> known, CancellationToken ct)
    {
        var entry = dto.EntryStepIds ?? [];
        var caches = dto.CacheIds ?? [];
        var assignments = dto.AssignmentIds ?? [];
        var steps = await DesignLogText.StepNamesAsync(_db, oldEntry.Concat(entry), ct);
        var cacheIds = oldCaches.Concat(caches).Distinct().ToList();
        var cacheNames = await _db.Set<CacheEntity>().AsNoTracking().Where(c => cacheIds.Contains(c.Id))
            .Select(c => new { c.Id, c.Name }).ToDictionaryAsync(c => c.Id, c => c.Name, ct);
        var assignmentIds = oldAssignments.Concat(assignments).Distinct().ToList();
        var assignmentNames = await _db.Set<AssignmentEntity>().AsNoTracking().Where(a => assignmentIds.Contains(a.Id))
            .Select(a => new { a.Id, a.Name }).ToDictionaryAsync(a => a.Id, a => a.Name, ct);
        foreach (var (id, n) in known) assignmentNames.TryAdd(id, n);
        string Named(Dictionary<Guid, string> names, Guid id) => names.TryGetValue(id, out var n) ? n : DesignLogText.Short(id);

        var parts = DesignLogText.Fields(
            ("name", before.Name, dto.Name), ("version", before.Version, dto.Version),
            ("description", before.Description, dto.Description), ("cronExpression", before.CronExpression, dto.CronExpression));
        if (DesignLogText.Links(oldEntry, entry, id => steps[id]) is { } e) parts.Add($"entry steps {e}");
        if (DesignLogText.Links(oldCaches, caches, id => Named(cacheNames, id)) is { } c) parts.Add($"caches {c}");
        if (DesignLogText.Links(oldAssignments, assignments, id => Named(assignmentNames, id)) is { } a)
            parts.Add($"assignments {a.Replace(" added", " linked").Replace(" removed", " unlinked (by the assignments stage)")}");
        return DesignLogText.Join(parts);
    }
}
