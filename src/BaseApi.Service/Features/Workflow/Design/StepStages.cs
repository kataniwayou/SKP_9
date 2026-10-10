using BaseApi.Core.Mapping;
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Step;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>
/// Stage 4: first the steps the design creates (2026-10-10, paste: a new id from the studio, refused when a step
/// with it exists; the step CRUD's create rules; its processor must exist; next steps follow in stage 5), then every
/// step the design changes. Steps are owned, so each changed one is checked against the stamp the
/// designer loaded, here and only here (stage 5 would see the stamp this stage moved); then its fields,
/// judged by the step CRUD's rules. A step that fails here is remembered, so stage 5 skips its wires.
/// </summary>
internal sealed class StepStage : IDesignStage
{
    private readonly BaseDbContext _db;
    private readonly IValidator<StepUpdateDto> _validator;
    private readonly IValidator<StepCreateDto> _createValidator;
    private readonly IEntityMapper<StepEntity, StepCreateDto, StepUpdateDto, StepReadDto> _mapper;

    public StepStage(BaseDbContext db, IValidator<StepUpdateDto> validator, IValidator<StepCreateDto> createValidator,
        IEntityMapper<StepEntity, StepCreateDto, StepUpdateDto, StepReadDto> mapper)
    {
        _db = db;
        _validator = validator;
        _createValidator = createValidator;
        _mapper = mapper;
    }

    private static string Noun(int create, int check) => (create, check) switch
    {
        (0, 1) => "step to check",
        (0, _) => "steps to check",
        (1, 0) => "step to create",
        (_, 0) => "steps to create",
        _ => "steps to create or check",
    };

    public async Task RunAsync(DesignRun run, CancellationToken ct)
    {
        var created = run.Request.NewSteps ?? [];
        var steps = run.Request.Steps ?? [];
        run.BeginStage("steps", created.Count + steps.Count, Noun(created.Count, steps.Count));
        var names = await DesignLogText.StepNamesAsync(_db,
            steps.Select(s => s.Id).Concat(created.Where(n => n.CopyOf is not null).Select(n => n.CopyOf!.Value)), ct);
        // a copy of a step this design also creates is named by that step's own name
        foreach (var n in created)
            if (DesignLogText.Text(n.Fields, "name") is { } name) names[n.Id] = name;
        foreach (var (id, name) in names)
            run.Label(id, $"step '{name}'");
        foreach (var n in created)
            await CreateAsync(run, n, names, ct);
        foreach (var s in steps)
        {
            string? change = null;
            var applied = await run.UnitAsync("step", s.Id, "steps", async () =>
            {
                var entity = await _db.Set<StepEntity>().FirstOrDefaultAsync(x => x.Id == s.Id, ct);
                if (entity is null) return [new FieldError(null, "This step no longer exists.")];
                if (DesignRun.IsStale(entity.UpdatedAt, s.UpdatedAt)) return [new FieldError(null, DesignRun.Conflict)];
                if (s.Fields is not { Count: > 0 }) return [];
                var errors = new List<FieldError>();
                var before = DesignFields.UpdateOf(entity);
                var dto = DesignFields.Apply(before, s.Fields, errors);
                // a field already refused (unknown name, wrong type) is its own error: no CRUD verdict on top of it
                if (errors.Count > 0) return errors;
                var problems = DesignFields.Failures(await _validator.ValidateAsync(dto, ct));
                if (problems.Count > 0) return problems;
                _mapper.Update(dto, entity);
                change = DesignLogText.Join(DesignLogText.Fields(
                    ("name", before.Name, dto.Name), ("version", before.Version, dto.Version), ("description", before.Description, dto.Description),
                    ("entryCondition", before.EntryCondition, dto.EntryCondition)));
                return problems;
            }, ct);
            if (!applied) run.FailedSteps.Add(s.Id);
            else if (change is null) run.Unchanged(s.Id);
            else run.Changed("step", s.Id, "updated", change);
        }
        run.EndStage();
    }

    /// <summary>One new step (a pasted copy): the same processor as its original, its own id and fields.</summary>
    private async Task CreateAsync(DesignRun run, DesignNewStepDto n, IReadOnlyDictionary<Guid, string> names, CancellationToken ct)
    {
        var applied = await run.UnitAsync("step", n.Id, "steps", async () =>
        {
            if (await _db.Set<StepEntity>().AnyAsync(x => x.Id == n.Id, ct))
                return [new FieldError(null, "Not created: a step with this id already exists.")];
            if (!await _db.Set<BaseApi.Service.Features.Processor.ProcessorEntity>().AnyAsync(p => p.Id == n.ProcessorId, ct))
                return [new FieldError("processorId", "Not created: its processor no longer exists.")];
            var errors = new List<FieldError>();
            // no field means its empty value: the CRUD's rules then say what is missing (an omitted entry condition is refused)
            var fields = DesignFields.Apply(new StepUpdateDto("", "", null, n.ProcessorId, null, default), n.Fields, errors);
            if (errors.Count > 0) return errors;
            var dto = new StepCreateDto(fields.Name, fields.Version, fields.Description, n.ProcessorId, null, fields.EntryCondition);
            var problems = DesignFields.Failures(await _createValidator.ValidateAsync(dto, ct));
            if (problems.Count > 0) return problems;
            var entity = _mapper.ToEntity(dto);
            entity.Id = n.Id;
            _db.Add(entity);
            return problems;
        }, ct);
        if (!applied)
        {
            run.FailedSteps.Add(n.Id);
            return;
        }
        run.CreatedSteps.Add(n.Id);
        var copy = n.CopyOf is { } of ? $" (copy of '{(names.TryGetValue(of, out var name) ? name : DesignLogText.Short(of))}')" : "";
        run.Changed("step", n.Id, "created", $"created{copy}", sentence: true);
    }
}

/// <summary>
/// Stage 5: replaces each changed step's next steps. No cycle check: a design may be anything, and starting
/// is when cycles are judged (spec §5). A missing next step is a foreign-key error on that step.
/// </summary>
internal sealed class WireStage : IDesignStage
{
    private readonly BaseDbContext _db;
    private readonly IValidator<StepUpdateDto> _validator;

    public WireStage(BaseDbContext db, IValidator<StepUpdateDto> validator)
    {
        _db = db;
        _validator = validator;
    }

    public async Task RunAsync(DesignRun run, CancellationToken ct)
    {
        // a created step's next steps too (2026-10-10): every step exists by now, so a new step may lead to another new one
        var rewired = (run.Request.Steps ?? []).Where(x => x.NextStepIds is not null)
            .Concat((run.Request.NewSteps ?? []).Where(n => n.NextStepIds is { Count: > 0 })
                .Select(n => new DesignStepDto(n.Id, null, null, n.NextStepIds)))
            .ToList();
        run.BeginStage("wires", rewired.Count, rewired.Count == 1 ? "step with new next steps" : "steps with new next steps");
        // the lists as they are and every name the lines need, read once (a unit changes only its own step's list)
        var ids = rewired.Select(s => s.Id).ToList();
        var current = (await _db.Set<StepNextSteps>().AsNoTracking().Where(j => ids.Contains(j.StepId))
                .Select(j => new { j.StepId, j.NextStepId }).ToListAsync(ct))
            .GroupBy(j => j.StepId).ToDictionary(g => g.Key, g => g.Select(j => j.NextStepId).ToList());
        var names = await DesignLogText.StepNamesAsync(_db,
            ids.Concat(current.Values.SelectMany(v => v)).Concat(rewired.SelectMany(s => s.NextStepIds!)), ct);
        foreach (var s in rewired)
        {
            if (run.FailedSteps.Contains(s.Id))
            {
                run.Fail("step", s.Id, "wires", "nextStepIds", "Not rewired: the step itself failed.");
                continue;
            }
            string? change = null;
            var applied = await run.UnitAsync("step", s.Id, "wires", async () =>
            {
                var entity = await _db.Set<StepEntity>().FirstOrDefaultAsync(x => x.Id == s.Id, ct);
                if (entity is null) return [new FieldError(null, "This step no longer exists.")];
                var problems = DesignFields.Failures(await _validator.ValidateAsync(DesignFields.UpdateOf(entity) with { NextStepIds = s.NextStepIds }, ct));
                if (problems.Count > 0) return problems;
                var before = current.GetValueOrDefault(s.Id) ?? [];
                // wires live only in StepNextSteps: force the stamp, as the graph saver does, so the next stale save conflicts
                _db.Entry(entity).Property(e => e.UpdatedAt).IsModified = true;
                await StepJunctions.SyncNextStepsAsync(_db, s.Id, s.NextStepIds, replaceExisting: true, ct);
                var links = DesignLogText.Links(before, s.NextStepIds!, t => $"{names[s.Id]}→{names[t]}");
                change = links is null ? null : $"next steps {links}";
                return problems;
            }, ct);
            if (!applied) continue;
            if (change is null) run.Unchanged(s.Id);
            else run.Changed("step", s.Id, "rewired", change);
        }
        run.EndStage();
    }
}
