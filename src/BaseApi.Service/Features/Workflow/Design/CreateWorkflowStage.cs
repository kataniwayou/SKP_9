using BaseApi.Core.Persistence;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>
/// Stage 0 (2026-10-10, Workspace › New workflow): a workflow that exists only in the studio is created with the route's
/// id, before every other stage, so they work on it as on any workflow. Its fields are judged by the workflow CRUD's own
/// rules (name, version, description, cron) except its entry steps, which the workflow stage sets and judges after the
/// steps exist; and its name must be no other workflow's. It holds the design's layout from the start; refused, the
/// later stages still report their own errors and the whole save rolls back. Runs only when the save creates it.
/// </summary>
internal sealed class CreateWorkflowStage : IDesignStage
{
    private readonly BaseDbContext _db;
    private readonly IValidator<WorkflowUpdateDto> _validator;

    public CreateWorkflowStage(BaseDbContext db, IValidator<WorkflowUpdateDto> validator)
    {
        _db = db;
        _validator = validator;
    }

    /// <summary>The fields a new workflow's request names, laid over empty ones (as a new step's are).</summary>
    public static WorkflowUpdateDto FieldsOf(DesignNewWorkflowDto nw, List<FieldError> errors) =>
        DesignFields.Apply(new WorkflowUpdateDto("", "", null, [], [], [], null), nw.Fields, errors);

    public async Task RunAsync(DesignRun run, CancellationToken ct)
    {
        if (!run.CreatesWorkflow || run.Request.NewWorkflow is not { } nw) return;
        run.BeginStage("create", 1, "workflow to create");
        var errors = new List<FieldError>();
        var dto = FieldsOf(nw, errors);
        run.Label(run.WorkflowId, dto.Name.Length > 0 ? $"workflow '{dto.Name}'" : "the new workflow");
        var applied = await run.UnitAsync("workflow", run.WorkflowId, "create", async () =>
        {
            if (errors.Count > 0) return errors;
            // the entry steps are the workflow stage's: they are set and judged there, once the steps exist
            var problems = DesignFields.Failures(await _validator.ValidateAsync(dto, ct))
                .Where(p => p.Field != "entryStepIds").ToList();
            if (problems.Count > 0) return problems;
            if (await _db.Set<WorkflowEntity>().AnyAsync(w => w.Name == dto.Name, ct))
                return [new FieldError("name", $"Not created: a workflow named '{dto.Name}' already exists.")];
            _db.Set<WorkflowEntity>().Add(new WorkflowEntity
            {
                Id = run.WorkflowId,
                Name = dto.Name,
                Version = dto.Version,
                Description = dto.Description,
                CronExpression = string.IsNullOrWhiteSpace(dto.CronExpression) ? null : dto.CronExpression,
                Layout = run.Request.Layout?.GetRawText(),
            });
            return [];
        }, ct);
        if (applied) run.Changed("workflow", run.WorkflowId, "created", "created (its entry steps, caches and assignments are set in the workflow stage)", sentence: true);
        else run.WorkflowMissing = true;
        run.EndStage();
    }
}
