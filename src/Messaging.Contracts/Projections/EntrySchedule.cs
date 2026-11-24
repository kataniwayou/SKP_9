using System.Text.RegularExpressions;

namespace Messaging.Contracts.Projections;

/// <summary>One set of entry steps that share an effective cron. <see cref="Index"/> is the group's
/// position in first-appearance order.</summary>
public sealed record EntryGroup(int Index, string Cron, IReadOnlyList<Guid> StepIds);

/// <summary>
/// The shared rule for entry-step schedules: a step fires on its entry cron, and a step without one is
/// unscheduled. A workflow has no cron of its own, so there is nothing to fall back to. Crons that differ
/// only in whitespace are the same cron.
/// </summary>
public static class EntrySchedule
{
    private static readonly Regex Spaces = new(@"\s+", RegexOptions.Compiled);

    /// <summary>Trims and collapses whitespace runs to a single space.</summary>
    public static string Normalize(string cron) => Spaces.Replace(cron.Trim(), " ");

    /// <summary>The normalized cron a step fires on, or null when it has none. Blank values count as absent.</summary>
    public static string? EffectiveCron(Guid stepId, IReadOnlyDictionary<Guid, string>? entryCrons)
        => entryCrons is not null && entryCrons.TryGetValue(stepId, out var cron) && !string.IsNullOrWhiteSpace(cron)
            ? Normalize(cron)
            : null;

    /// <summary>Groups entry steps by effective cron, ordered by each cron's first appearance. Unscheduled steps are left out.</summary>
    public static IReadOnlyList<EntryGroup> Groups(
        IReadOnlyList<Guid> entryStepIds, IReadOnlyDictionary<Guid, string>? entryCrons)
    {
        var order = new List<string>();
        var members = new Dictionary<string, List<Guid>>();
        foreach (var id in entryStepIds)
        {
            var cron = EffectiveCron(id, entryCrons);
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
