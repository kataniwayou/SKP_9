using Messaging.Contracts;

namespace BaseApi.Service.Features.Orchestration.Projection;

/// <summary>
/// Each step's role in one workflow's graph: entry if it is an entry step, terminal if it has no
/// successors, intermediate otherwise. Entry wins over terminal, so a single-step workflow's step is
/// entry. Computed from the projection being written, so it describes the graph the pods will run.
/// </summary>
internal static class StepRoleClassifier
{
    internal static IReadOnlyDictionary<Guid, string> Classify(
        IReadOnlyCollection<Guid> entryStepIds, IReadOnlyCollection<StepL1> steps)
    {
        var entries = entryStepIds.ToHashSet();

        return steps
            .GroupBy(s => s.StepId)
            .ToDictionary(
                g => g.Key,
                g => entries.Contains(g.Key) ? StepRoles.Entry
                   : g.First().NextStepIds is { Count: > 0 } ? StepRoles.Intermediate
                   : StepRoles.Terminal);
    }
}
