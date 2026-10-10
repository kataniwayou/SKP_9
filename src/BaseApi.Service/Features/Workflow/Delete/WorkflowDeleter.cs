using BaseApi.Core.Exceptions;
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow.Design;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow.Delete;

/// <summary>
/// The answer of <c>POST /workflows/{id}/delete</c> (2026-10-10): what the deletion would delete (a dry run) or deleted,
/// what it keeps, every error, and its log.
/// </summary>
/// <param name="Applied">True when the workflow was deleted (never on a dry run).</param>
/// <param name="DryRun">True when this was a dry run: everything was done in a transaction and rolled back.</param>
/// <param name="Steps">The steps it deletes (its own: those its entry steps reach and its layout places).</param>
/// <param name="Assignments">The assignments it deletes (those it lists and those of its steps).</param>
/// <param name="Caches">The caches it lists: kept, only unlinked from it.</param>
/// <param name="Processors">The processors its steps run: kept, untouched.</param>
/// <param name="Errors">Why it may not be deleted (running, or a step or assignment another workflow uses); empty when it may.</param>
/// <param name="Log">What the deletion did, in order, as the design save's log.</param>
public sealed record WorkflowDeleteOutcomeDto(
    bool Applied, bool DryRun, int Steps, int Assignments, int Caches, int Processors, List<DesignErrorDto> Errors, List<DesignLogDto> Log);

/// <summary>Deletes a workflow with its own steps and assignments, never its caches or processors (2026-10-10).</summary>
public interface IWorkflowDeleter
{
    Task<WorkflowDeleteOutcomeDto> DeleteAsync(Guid workflowId, bool dryRun, CancellationToken ct);
}

/// <summary>
/// A workflow's deletion (the user's rules, 2026-10-10): it is refused while the workflow runs (its running copy could
/// never be stopped by an id that is gone), and while a step or assignment of it is used by another workflow (the
/// designer never shares them; old data might). Its own steps (what its entry steps reach and its layout places) go with
/// their next-step links and its assignments; its caches are only unlinked, and processors are never touched. Like the
/// design save, it runs in one transaction: a dry run rolls back and says what would be deleted; the real run holds the
/// start guard (<see cref="IWorkflowRunGuard"/>) from before its live check to the end, commits, then removes what the
/// workflow projected.
/// </summary>
internal sealed class WorkflowDeleter : IWorkflowDeleter
{
    private const string Stage = "delete";

    private readonly BaseDbContext _db;
    private readonly IDesignTransactions _transactions;
    private readonly IWorkflowRunGuard _guard;

    public WorkflowDeleter(BaseDbContext db, IDesignTransactions transactions, IWorkflowRunGuard guard)
    {
        _db = db;
        _transactions = transactions;
        _guard = guard;
    }

    private static string Count(int n, string one) => $"{n} {one}{(n == 1 ? "" : "s")}";

    public async Task<WorkflowDeleteOutcomeDto> DeleteAsync(Guid workflowId, bool dryRun, CancellationToken ct)
    {
        var workflow = await _db.Set<WorkflowEntity>().AsNoTracking().Where(w => w.Id == workflowId)
            .Select(w => new { w.Name }).FirstOrDefaultAsync(ct)
            ?? throw new NotFoundException(nameof(WorkflowEntity), workflowId);

        // the real run holds the start guard from before its live check: a start can no longer slip in
        if (!dryRun) await _guard.BeginDeleteAsync(workflowId, ct);
        var deleted = false;
        var steps = new List<Guid>();
        try
        {
            var outcome = await RunAsync(workflowId, workflow.Name, dryRun, steps, ct);
            deleted = outcome.Applied;
            return outcome;
        }
        finally
        {
            if (!dryRun) await _guard.EndDeleteAsync(workflowId, deleted, deleted ? steps : [], CancellationToken.None);
        }
    }

    private async Task<WorkflowDeleteOutcomeDto> RunAsync(Guid workflowId, string name, bool dryRun, List<Guid> stepsOut, CancellationToken ct)
    {
        var (owned, _) = await DesignOwnership.ReadAsync(_db, workflowId, ct);
        var ownedIds = owned.ToList();
        var steps = await _db.Set<StepEntity>().AsNoTracking().Where(s => ownedIds.Contains(s.Id))
            .Select(s => new { s.Id, s.Name, s.ProcessorId }).ToListAsync(ct);
        var stepIds = steps.Select(s => s.Id).ToList();
        stepsOut.AddRange(stepIds);
        var linked = await _db.Set<WorkflowAssignments>().AsNoTracking().Where(j => j.WorkflowId == workflowId).Select(j => j.AssignmentId).ToListAsync(ct);
        var assignments = await _db.Set<AssignmentEntity>().AsNoTracking().Where(a => linked.Contains(a.Id) || stepIds.Contains(a.StepId))
            .Select(a => new { a.Id, a.Name, a.StepId }).ToListAsync(ct);
        var assignmentIds = assignments.Select(a => a.Id).ToList();
        var caches = await _db.Set<WorkflowCaches>().AsNoTracking().Where(j => j.WorkflowId == workflowId).Select(j => j.CacheId).Distinct().CountAsync(ct);
        var processors = steps.Select(s => s.ProcessorId).Distinct().Count();

        await using var tx = await _transactions.BeginAsync(ct);
        var run = new DesignRun(workflowId, new DesignSaveRequest(null, null, null, null, null, null, null), _db, tx);
        run.Label(workflowId, $"workflow '{name}'");
        foreach (var s in steps) run.Label(s.Id, $"step '{s.Name}'");
        foreach (var a in assignments) run.Label(a.Id, $"assignment '{a.Name}'");
        WorkflowDeleteOutcomeDto Answer(bool applied) =>
            new(applied, dryRun, steps.Count, assignments.Count, caches, processors, run.Errors, run.Log);

        run.Note("outcome", "outcome", dryRun
            ? "dry run started: the deletion in one transaction, rolled back at the end"
            : "deletion started: the start guard is held; the deletion in one transaction");

        // ---- 1. Liveness, read now: deleted while running, its running copy could never be stopped. ----
        if (await _guard.IsLiveAsync(workflowId, ct))
            run.Fail("workflow", workflowId, "liveness", null, "running: stop it first. Deleted while running, it could never be stopped.");
        else
            run.Note("liveness", "stage", "liveness: not running (read now)");

        // ---- 2. Nothing of it may be used by another workflow. -----------------------------------------
        foreach (var (id, why) in await SharedAsync(workflowId, stepIds, assignmentIds, ct))
            run.Fail(steps.Any(s => s.Id == id) ? "step" : "assignment", id, Stage, null, why);

        if (run.Errors.Count == 0)
        {
            // ---- 3. The deletion: links first, then assignments and steps, then the workflow. -------------
            run.BeginStage(Stage, 1 + steps.Count + assignments.Count, "entities to delete");
            var applied = await run.UnitAsync("workflow", workflowId, Stage, async () =>
            {
                _db.RemoveRange(await _db.Set<StepNextSteps>().Where(j => stepIds.Contains(j.StepId) || stepIds.Contains(j.NextStepId)).ToListAsync(ct));
                _db.RemoveRange(await _db.Set<WorkflowEntrySteps>().Where(j => j.WorkflowId == workflowId).ToListAsync(ct));
                _db.RemoveRange(await _db.Set<WorkflowAssignments>().Where(j => j.WorkflowId == workflowId).ToListAsync(ct));
                _db.RemoveRange(await _db.Set<WorkflowCaches>().Where(j => j.WorkflowId == workflowId).ToListAsync(ct));
                _db.RemoveRange(await _db.Set<AssignmentEntity>().Where(a => assignmentIds.Contains(a.Id)).ToListAsync(ct));
                _db.RemoveRange(await _db.Set<StepEntity>().Where(s => stepIds.Contains(s.Id)).ToListAsync(ct));
                var row = await _db.Set<WorkflowEntity>().FirstOrDefaultAsync(w => w.Id == workflowId, ct);
                if (row is not null) _db.Remove(row);
                return [];
            }, ct);
            if (applied)
            {
                foreach (var a in assignments) run.Changed("assignment", a.Id, "deleted", "deleted", sentence: true);
                foreach (var s in steps) run.Changed("step", s.Id, "deleted", "deleted", sentence: true);
                run.Changed("workflow", workflowId, "deleted", "deleted: its id is gone for good", sentence: true);
            }
            run.EndStage();
            run.Note(Stage, "stage", $"kept: {Count(caches, "cache")} (unlinked only), {Count(processors, "processor")} (untouched)");
        }

        if (run.Errors.Count > 0)
        {
            await tx.RollbackAsync(CancellationToken.None);
            run.MarkRolledBack();
            run.Note("outcome", "outcome", $"{(dryRun ? "dry run failed" : "not deleted")}: {Count(run.Errors.Count, "error")}", "error");
            run.Note("outcome", "outcome", "rolled back: nothing was deleted", "error");
            return Answer(false);
        }
        if (dryRun)
        {
            await tx.RollbackAsync(CancellationToken.None);
            run.MarkRolledBack();
            run.Note("outcome", "outcome",
                $"dry run passed: it would delete the workflow, {Count(steps.Count, "step")} and {Count(assignments.Count, "assignment")}; rolled back, nothing deleted");
            return Answer(false);
        }
        await tx.CommitAsync(ct);
        run.Note("outcome", "outcome",
            $"committed: the workflow, {Count(steps.Count, "step")} and {Count(assignments.Count, "assignment")} deleted; what it projected is removed");
        return Answer(true);
    }

    /// <summary>
    /// Each of its steps and assignments another workflow uses, with why: another workflow's entry step or layout, a
    /// step not of this workflow listing it as a next step, another workflow's assignment link.
    /// </summary>
    private async Task<List<(Guid Id, string Why)>> SharedAsync(Guid workflowId, List<Guid> stepIds, List<Guid> assignmentIds, CancellationToken ct)
    {
        var found = new List<(Guid, string)>();
        var names = await _db.Set<WorkflowEntity>().AsNoTracking().Where(w => w.Id != workflowId)
            .Select(w => new { w.Id, w.Name, w.Layout }).ToListAsync(ct);
        foreach (var e in await _db.Set<WorkflowEntrySteps>().AsNoTracking().Where(j => j.WorkflowId != workflowId && stepIds.Contains(j.StepId)).ToListAsync(ct))
            found.Add((e.StepId, $"used by workflow '{names.FirstOrDefault(w => w.Id == e.WorkflowId)?.Name ?? DesignLogText.Short(e.WorkflowId)}' (an entry step there)"));
        foreach (var w in names)
            foreach (var s in DesignOwnership.LayoutSteps(w.Layout).Where(stepIds.Contains).Distinct())
                found.Add((s, $"used by workflow '{w.Name}' (placed in its layout)"));
        var feeders = await _db.Set<StepNextSteps>().AsNoTracking().Where(j => stepIds.Contains(j.NextStepId) && !stepIds.Contains(j.StepId)).ToListAsync(ct);
        var feederNames = await DesignLogText.StepNamesAsync(_db, feeders.Select(f => f.StepId), ct);
        foreach (var f in feeders)
            found.Add((f.NextStepId, $"used: step '{feederNames[f.StepId]}' of another workflow lists it as a next step"));
        foreach (var l in await _db.Set<WorkflowAssignments>().AsNoTracking().Where(j => j.WorkflowId != workflowId && assignmentIds.Contains(j.AssignmentId)).ToListAsync(ct))
            found.Add((l.AssignmentId, $"used by workflow '{names.FirstOrDefault(w => w.Id == l.WorkflowId)?.Name ?? DesignLogText.Short(l.WorkflowId)}' (linked there)"));
        return found.Select(f => (f.Item1, $"not deleted: {f.Item2}")).ToList();
    }
}
