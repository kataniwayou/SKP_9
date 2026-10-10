using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Cache;
using BaseApi.Service.Features.Step;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>
/// Stage 8 (2026-10-10, the studio's Delete): the steps and caches the design deletes, last, once the wires stage has
/// taken them out of this workflow's next-step lists and the workflow stage out of its entry steps and caches. A step
/// (owned) is checked against the stamp the designer loaded; it is refused while anything still uses it (any workflow's
/// entry steps, any step's next steps, an assignment of another workflow), else its assignments of this workflow are
/// unlinked and deleted with it. A cache (shared) is refused while any workflow still lists it. A refusal is an error
/// like any other, so the whole save rolls back. One already gone is what was asked (unchanged).
/// </summary>
internal sealed class DeleteStage : IDesignStage
{
    private readonly BaseDbContext _db;

    public DeleteStage(BaseDbContext db) => _db = db;

    private static string Noun(int steps, int caches) => (steps, caches) switch
    {
        (1, 0) => "step to delete",
        (_, 0) => "steps to delete",
        (0, 1) => "cache to delete",
        (0, _) => "caches to delete",
        _ => "steps and caches to delete",
    };

    public async Task RunAsync(DesignRun run, CancellationToken ct)
    {
        var steps = run.Request.DeletedSteps ?? [];
        var caches = run.Request.DeletedCaches ?? [];
        run.BeginStage("deletes", steps.Count + caches.Count, Noun(steps.Count, caches.Count));
        if (steps.Count + caches.Count == 0)
        {
            run.EndStage();
            return;
        }
        foreach (var (id, name) in await DesignLogText.StepNamesAsync(_db, steps.Select(s => s.Id), ct))
            run.Label(id, $"step '{name}'");
        var cacheIds = caches.Select(c => c.Id).ToList();
        foreach (var c in await _db.Set<CacheEntity>().AsNoTracking().Where(x => cacheIds.Contains(x.Id)).Select(x => new { x.Id, x.Name }).ToListAsync(ct))
            run.Label(c.Id, $"cache '{c.Name}'");

        var deleted = steps.Select(s => s.Id).ToList();
        foreach (var d in steps)
        {
            var gone = false;
            string? change = null;
            var applied = await run.UnitAsync("step", d.Id, "deletes", async () =>
            {
                var entity = await _db.Set<StepEntity>().FirstOrDefaultAsync(x => x.Id == d.Id, ct);
                if (entity is null)
                {
                    gone = true;
                    return [];
                }
                if (!run.WorkflowSteps.Contains(d.Id)) return [new FieldError(null, "Not deleted: not a step of this workflow.")];
                if (DesignRun.IsStale(entity.UpdatedAt, d.UpdatedAt)) return [new FieldError(null, DesignRun.Conflict)];

                var assignments = await _db.Set<AssignmentEntity>().Where(a => a.StepId == d.Id).ToListAsync(ct);
                var assignmentIds = assignments.Select(a => a.Id).ToList();
                var links = await _db.Set<WorkflowAssignments>().Where(j => assignmentIds.Contains(j.AssignmentId)).ToListAsync(ct);
                var uses = await StepUsesAsync(run.WorkflowId, d.Id, deleted, links, ct);
                if (uses.Count > 0) return [new FieldError(null, $"Not deleted: {string.Join("; ", uses)}.")];

                // its own next steps (a link to itself too) and the links into it from steps deleted with it, its
                // assignments of this workflow, then the step
                _db.RemoveRange(await _db.Set<StepNextSteps>().Where(j => j.StepId == d.Id || (j.NextStepId == d.Id && deleted.Contains(j.StepId))).ToListAsync(ct));
                _db.RemoveRange(links);
                _db.RemoveRange(assignments);
                _db.Remove(entity);
                change = assignments.Count == 0 ? "deleted"
                    : $"deleted, with its assignment{(assignments.Count == 1 ? "" : "s")} {string.Join(", ", assignments.Select(a => $"'{a.Name}'"))}";
                return [];
            }, ct);
            if (!applied) continue;
            if (gone) run.Unchanged(d.Id);
            else run.Changed("step", d.Id, "deleted", change!, sentence: true);
        }

        foreach (var d in caches)
        {
            var gone = false;
            var applied = await run.UnitAsync("cache", d.Id, "deletes", async () =>
            {
                var entity = await _db.Set<CacheEntity>().FirstOrDefaultAsync(x => x.Id == d.Id, ct);
                if (entity is null)
                {
                    gone = true;
                    return [];
                }
                if (!run.WorkflowCaches.Contains(d.Id)) return [new FieldError(null, "Not deleted: not a cache of this workflow.")];
                var users = await _db.Set<WorkflowCaches>().AsNoTracking().Where(j => j.CacheId == d.Id).Select(j => j.WorkflowId).Distinct().ToListAsync(ct);
                if (users.Count > 0)
                {
                    var names = await WorkflowNamesAsync(users, ct);
                    var who = users.Select(w => w == run.WorkflowId ? "this workflow still lists it" : $"still used by workflow '{names[w]}'");
                    return [new FieldError(null, $"Not deleted: {string.Join("; ", who)}.")];
                }
                _db.Remove(entity);
                return [];
            }, ct);
            if (!applied) continue;
            if (gone) run.Unchanged(d.Id);
            else run.Changed("cache", d.Id, "deleted", "deleted", sentence: true);
        }
        run.EndStage();
    }

    /// <summary>
    /// Why a step may not be deleted yet, one reason each: a workflow lists it as an entry step, a step lists it as a next
    /// step, another workflow has an assignment for it. Empty when nothing uses it.
    /// </summary>
    private async Task<List<string>> StepUsesAsync(Guid workflowId, Guid stepId, List<Guid> deleted, List<WorkflowAssignments> links, CancellationToken ct)
    {
        var uses = new List<string>();
        var entryOf = await _db.Set<WorkflowEntrySteps>().AsNoTracking().Where(j => j.StepId == stepId).Select(j => j.WorkflowId).Distinct().ToListAsync(ct);
        // a step this design deletes too goes with its links: it uses nothing
        var feeders = await _db.Set<StepNextSteps>().AsNoTracking().Where(j => j.NextStepId == stepId && j.StepId != stepId && !deleted.Contains(j.StepId))
            .Select(j => j.StepId).ToListAsync(ct);
        var assignedBy = links.Where(j => j.WorkflowId != workflowId).Select(j => j.WorkflowId).Distinct().ToList();
        var workflows = await WorkflowNamesAsync(entryOf.Concat(assignedBy), ct);
        var steps = await DesignLogText.StepNamesAsync(_db, feeders, ct);
        foreach (var w in entryOf)
            uses.Add(w == workflowId ? "this workflow still lists it as an entry step" : $"still used by workflow '{workflows[w]}' (an entry step there)");
        foreach (var s in feeders)
            uses.Add($"still used: step '{steps[s]}' lists it as a next step");
        foreach (var w in assignedBy)
            uses.Add($"still used by workflow '{workflows[w]}' (its assignment for this step)");
        return uses;
    }

    private async Task<Dictionary<Guid, string>> WorkflowNamesAsync(IEnumerable<Guid> ids, CancellationToken ct)
    {
        var wanted = ids.Distinct().ToList();
        var names = await _db.Set<WorkflowEntity>().AsNoTracking().Where(w => wanted.Contains(w.Id))
            .Select(w => new { w.Id, w.Name }).ToDictionaryAsync(w => w.Id, w => w.Name, ct);
        foreach (var id in wanted) names.TryAdd(id, DesignLogText.Short(id));
        return names;
    }
}
