using BaseApi.Core.Mapping;
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Step;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>
/// Stage 4: every step the design names. Steps are owned, so each is checked against the stamp the
/// designer loaded, here and only here (stage 5 would see the stamp this stage moved); then its fields,
/// judged by the step CRUD's rules. A step that fails here is remembered, so stage 5 skips its wires.
/// </summary>
internal sealed class StepStage : IDesignStage
{
    private readonly BaseDbContext _db;
    private readonly IValidator<StepUpdateDto> _validator;
    private readonly IEntityMapper<StepEntity, StepCreateDto, StepUpdateDto, StepReadDto> _mapper;

    public StepStage(BaseDbContext db, IValidator<StepUpdateDto> validator,
        IEntityMapper<StepEntity, StepCreateDto, StepUpdateDto, StepReadDto> mapper)
    {
        _db = db;
        _validator = validator;
        _mapper = mapper;
    }

    public async Task RunAsync(DesignRun run, CancellationToken ct)
    {
        foreach (var s in run.Request.Steps ?? [])
        {
            var applied = await run.UnitAsync("step", s.Id, "steps", async () =>
            {
                var entity = await _db.Set<StepEntity>().FirstOrDefaultAsync(x => x.Id == s.Id, ct);
                if (entity is null) return [new FieldError(null, "This step no longer exists.")];
                if (DesignRun.IsStale(entity.UpdatedAt, s.UpdatedAt)) return [new FieldError(null, DesignRun.Conflict)];
                if (s.Fields is not { Count: > 0 }) return [];
                var errors = new List<FieldError>();
                var dto = DesignFields.Apply(DesignFields.UpdateOf(entity), s.Fields, errors);
                // a field already refused (unknown name, wrong type) is its own error: no CRUD verdict on top of it
                if (errors.Count > 0) return errors;
                var problems = DesignFields.Failures(await _validator.ValidateAsync(dto, ct));
                if (problems.Count > 0) return problems;
                _mapper.Update(dto, entity);
                return problems;
            }, ct);
            if (!applied) run.FailedSteps.Add(s.Id);
        }
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
        foreach (var s in (run.Request.Steps ?? []).Where(x => x.NextStepIds is not null))
        {
            if (run.FailedSteps.Contains(s.Id))
            {
                run.Fail("step", s.Id, "wires", "nextStepIds", "Not rewired: the step itself failed.");
                continue;
            }
            await run.UnitAsync("step", s.Id, "wires", async () =>
            {
                var entity = await _db.Set<StepEntity>().FirstOrDefaultAsync(x => x.Id == s.Id, ct);
                if (entity is null) return [new FieldError(null, "This step no longer exists.")];
                var problems = DesignFields.Failures(await _validator.ValidateAsync(DesignFields.UpdateOf(entity) with { NextStepIds = s.NextStepIds }, ct));
                if (problems.Count > 0) return problems;
                // wires live only in StepNextSteps: force the stamp, as the graph saver does, so the next stale save conflicts
                _db.Entry(entity).Property(e => e.UpdatedAt).IsModified = true;
                await StepJunctions.SyncNextStepsAsync(_db, s.Id, s.NextStepIds, replaceExisting: true, ct);
                return problems;
            }, ct);
        }
    }
}
