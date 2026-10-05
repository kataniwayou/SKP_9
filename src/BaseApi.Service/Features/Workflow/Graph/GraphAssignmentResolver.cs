using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Step;
using FluentValidation;
using FluentValidation.Results;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow.Graph;

/// <summary>
/// Turns per-step assignment intents into the workflow's final assignment set, applying the rules
/// the editor hides from the user: an assignment is edited per (workflow, step), but a row may be
/// linked by several workflows, so editing a shared row must not change the others.
/// Stages changes only; the saver saves.
/// </summary>
internal sealed class GraphAssignmentResolver
{
    private const int MaxNameLength = 200;

    private readonly BaseDbContext _db;
    private readonly IValidator<AssignmentCreateDto> _payloadValidator;

    public GraphAssignmentResolver(BaseDbContext db, IValidator<AssignmentCreateDto> payloadValidator)
    {
        _db = db;
        _payloadValidator = payloadValidator;
    }

    public async Task<List<Guid>> ResolveAsync(
        Guid workflowId, string workflowName, IReadOnlyList<GraphAssignmentIntent> intents, CancellationToken ct)
    {
        // The payload rules (non-empty, at most 1 MB, parses as JSON) are the CRUD validator's.
        var failures = new List<ValidationFailure>();
        foreach (var intent in intents.Where(i => i.Payload is not null))
        {
            var probe = new AssignmentCreateDto("validation", "1.0.0", null, intent.StepId, intent.Payload!);
            failures.AddRange((await _payloadValidator.ValidateAsync(probe, ct)).Errors.Select(e =>
                new ValidationFailure($"Assignments[{intent.StepId}].{e.PropertyName}", e.ErrorMessage)));
        }
        if (failures.Count > 0)
            throw new ValidationException(failures);

        var linkedIds = await _db.Set<WorkflowAssignments>()
            .Where(j => j.WorkflowId == workflowId)
            .Select(j => j.AssignmentId)
            .ToListAsync(ct);

        var linked = await _db.Set<AssignmentEntity>()
            .Where(a => linkedIds.Contains(a.Id))
            .OrderBy(a => a.Id)
            .ToListAsync(ct);

        var final = linkedIds.ToHashSet();

        foreach (var intent in intents)
        {
            var current = linked.Where(a => a.StepId == intent.StepId).ToList();
            var target = intent.Payload is null ? null : current.FirstOrDefault();

            // Everything for this step except the row the intent keeps is unlinked, and deleted when
            // no other workflow still links it. This also collapses legacy duplicates to one.
            foreach (var row in current.Where(r => r != target))
            {
                final.Remove(row.Id);
                if (!await IsLinkedElsewhereAsync(row.Id, workflowId, ct))
                    _db.Remove(row);
            }

            if (intent.Payload is null)
                continue;

            if (target is null)
            {
                var created = new AssignmentEntity
                {
                    Id = Guid.NewGuid(),
                    StepId = intent.StepId,
                    Name = await NameAsync(workflowName, intent.StepId, ct),
                    Version = "1.0.0",
                    Payload = intent.Payload,
                };
                _db.Add(created);
                final.Add(created.Id);
            }
            else if (await IsLinkedElsewhereAsync(target.Id, workflowId, ct))
            {
                var copy = new AssignmentEntity
                {
                    Id = Guid.NewGuid(),
                    StepId = target.StepId,
                    Name = target.Name,
                    Version = target.Version,
                    Description = target.Description,
                    Payload = intent.Payload,
                };
                _db.Add(copy);
                final.Remove(target.Id);
                final.Add(copy.Id);
            }
            else
            {
                target.Payload = intent.Payload;
            }
        }

        return final.ToList();
    }

    private Task<bool> IsLinkedElsewhereAsync(Guid assignmentId, Guid workflowId, CancellationToken ct) =>
        _db.Set<WorkflowAssignments>().AnyAsync(j => j.AssignmentId == assignmentId && j.WorkflowId != workflowId, ct);

    /// <summary><c>"{workflow} / {step}"</c>; FindAsync also sees a step staged earlier in this same save.</summary>
    private async Task<string> NameAsync(string workflowName, Guid stepId, CancellationToken ct)
    {
        var step = await _db.Set<StepEntity>().FindAsync([stepId], ct);
        var name = $"{workflowName} / {step?.Name ?? stepId.ToString("N")}";
        return name.Length <= MaxNameLength ? name : name[..MaxNameLength];
    }
}
