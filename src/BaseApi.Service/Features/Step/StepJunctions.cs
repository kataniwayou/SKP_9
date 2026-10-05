using BaseApi.Core.Persistence;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Step;

/// <summary>
/// The next-step junction sync, shared by <see cref="StepService"/> and the graph saver so a graph
/// save and a plain step PUT write wires the same way. Stages changes only; the caller saves.
/// </summary>
internal static class StepJunctions
{
    /// <summary>
    /// Stages the step's outgoing wires. With <paramref name="replaceExisting"/> every stored wire of
    /// the step is removed first (remove-and-replace, as on update); without it the new wires are
    /// only added (as on create, where none exist yet).
    /// </summary>
    internal static async Task SyncNextStepsAsync(
        BaseDbContext db,
        Guid stepId,
        IReadOnlyCollection<Guid>? nextStepIds,
        bool replaceExisting,
        CancellationToken ct)
    {
        var set = db.Set<StepNextSteps>();

        if (replaceExisting)
        {
            var existing = await set.Where(j => j.StepId == stepId).ToListAsync(ct);
            if (existing.Count > 0)
            {
                set.RemoveRange(existing);
            }
        }

        if (nextStepIds is { Count: > 0 })
        {
            await set.AddRangeAsync(
                nextStepIds.Select(nextId => new StepNextSteps { StepId = stepId, NextStepId = nextId }), ct);
        }
    }
}
