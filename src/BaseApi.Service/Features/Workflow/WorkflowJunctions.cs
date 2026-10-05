using BaseApi.Core.Persistence;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow;

/// <summary>
/// The sync of a workflow's three junctions (entry steps, assignments, caches), shared by
/// <see cref="WorkflowService"/> and the graph saver. Stages changes only; the caller saves.
/// </summary>
internal static class WorkflowJunctions
{
    /// <summary>
    /// Stages the workflow's junction rows. With <paramref name="replaceExisting"/> every stored row
    /// on all three junctions is removed first, so the arguments are the complete final state.
    /// </summary>
    internal static async Task SyncAsync(
        BaseDbContext db,
        Guid workflowId,
        IReadOnlyCollection<Guid> entryStepIds,
        IReadOnlyCollection<Guid>? assignmentIds,
        IReadOnlyCollection<Guid>? cacheIds,
        bool replaceExisting,
        CancellationToken ct)
    {
        var entryStepsSet = db.Set<WorkflowEntrySteps>();
        var assignmentsSet = db.Set<WorkflowAssignments>();
        var cachesSet = db.Set<WorkflowCaches>();

        if (replaceExisting)
        {
            var existingEntrySteps = await entryStepsSet.Where(j => j.WorkflowId == workflowId).ToListAsync(ct);
            if (existingEntrySteps.Count > 0)
            {
                entryStepsSet.RemoveRange(existingEntrySteps);
            }

            var existingAssignments = await assignmentsSet.Where(j => j.WorkflowId == workflowId).ToListAsync(ct);
            if (existingAssignments.Count > 0)
            {
                assignmentsSet.RemoveRange(existingAssignments);
            }

            var existingCaches = await cachesSet.Where(j => j.WorkflowId == workflowId).ToListAsync(ct);
            if (existingCaches.Count > 0)
            {
                cachesSet.RemoveRange(existingCaches);
            }
        }

        if (entryStepIds.Count > 0)
        {
            await entryStepsSet.AddRangeAsync(
                entryStepIds.Select(stepId => new WorkflowEntrySteps { WorkflowId = workflowId, StepId = stepId }), ct);
        }

        if (assignmentIds is { Count: > 0 })
        {
            await assignmentsSet.AddRangeAsync(
                assignmentIds.Select(id => new WorkflowAssignments { WorkflowId = workflowId, AssignmentId = id }), ct);
        }

        if (cacheIds is { Count: > 0 })
        {
            await cachesSet.AddRangeAsync(
                cacheIds.Select(id => new WorkflowCaches { WorkflowId = workflowId, CacheId = id }), ct);
        }
    }
}
