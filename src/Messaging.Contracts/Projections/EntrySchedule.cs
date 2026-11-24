using System.Text.RegularExpressions;

namespace Messaging.Contracts.Projections;

/// <summary>One set of entry steps that share an effective cron. <see cref="Index"/> is the group's
/// position in first-appearance order.</summary>
public sealed record EntryGroup(int Index, string Cron, IReadOnlyList<Guid> StepIds);

/// <summary>
/// The shared rule for entry-step schedules: a step's own cron wins, else the workflow cron, else the
/// step is unscheduled. Crons that differ only in whitespace are the same cron.
/// </summary>
public static class EntrySchedule
{
    private static readonly Regex Spaces = new(@"\s+", RegexOptions.Compiled);

    /// <summary>Trims and collapses whitespace runs to a single space.</summary>
    public static string Normalize(string cron) => Spaces.Replace(cron.Trim(), " ");

    /// <summary>The normalized cron a step fires on, or null when none applies. Blank values count as absent.</summary>
    public static string? EffectiveCron(Guid stepId, string? workflowCron, IReadOnlyDictionary<Guid, string>? entryCrons)
    {
        if (entryCrons is not null && entryCrons.TryGetValue(stepId, out var own) && !string.IsNullOrWhiteSpace(own))
            return Normalize(own);
        return string.IsNullOrWhiteSpace(workflowCron) ? null : Normalize(workflowCron);
    }

    /// <summary>Groups entry steps by effective cron, ordered by each cron's first appearance. Unscheduled steps are left out.</summary>
    public static IReadOnlyList<EntryGroup> Groups(
        IReadOnlyList<Guid> entryStepIds, string? workflowCron, IReadOnlyDictionary<Guid, string>? entryCrons)
    {
        var order = new List<string>();
        var members = new Dictionary<string, List<Guid>>();
        foreach (var id in entryStepIds)
        {
            var cron = EffectiveCron(id, workflowCron, entryCrons);
            if (cron is null) continue;
            if (!members.TryGetValue(cron, out var list))
            {
                members[cron] = list = [];
                order.Add(cron);
            }
            list.Add(id);
        }
        return order.Select((c, i) => new EntryGroup(i, c, members[c])).ToList();
    }
}
