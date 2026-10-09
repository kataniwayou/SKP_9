using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Step;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>
/// The words of the design log (<see cref="DesignLogDto"/>): what changed on an entity, field by field, and
/// how a list of links changed. Only what the stage actually wrote is described.
/// </summary>
internal static class DesignLogText
{
    private const int Shown = 40;

    /// <summary>
    /// The fields that differ, as "name 'a' → 'b'"; a long value (a description, a payload, a definition)
    /// as "payload changed". Empty when nothing differs.
    /// </summary>
    public static List<string> Fields(params (string Field, object? Before, object? After)[] fields)
    {
        var changes = new List<string>();
        foreach (var (field, before, after) in fields)
        {
            if (Equals(before, after)) continue;
            var b = Show(before);
            var a = Show(after);
            changes.Add(b is null || a is null ? $"{field} changed" : $"{field} {b} → {a}");
        }
        return changes;
    }

    private static string? Show(object? value) => value switch
    {
        null => "none",
        string s when s.Length > Shown || s.Contains('\n') => null,
        string s => $"'{s}'",
        Guid g => Short(g),
        _ => value.ToString(),
    };

    /// <summary>
    /// How a list of links changed: "a→e added, a→c removed" (each <paramref name="arrow"/> names the link), or
    /// "reordered" when only the order differs; null when it is the same list.
    /// </summary>
    public static string? Links(IReadOnlyList<Guid> before, IReadOnlyList<Guid> after, Func<Guid, string> arrow)
    {
        var added = after.Where(id => !before.Contains(id)).Distinct().ToList();
        var removed = before.Where(id => !after.Contains(id)).Distinct().ToList();
        var parts = new List<string>();
        if (added.Count > 0) parts.Add($"{string.Join(", ", added.Select(arrow))} added");
        if (removed.Count > 0) parts.Add($"{string.Join(", ", removed.Select(arrow))} removed");
        if (parts.Count > 0) return string.Join(", ", parts);
        return before.SequenceEqual(after) ? null : "reordered";
    }

    /// <summary>One text from the parts that are not empty, or null when there are none.</summary>
    public static string? Join(IEnumerable<string?> parts)
    {
        var kept = parts.Where(p => !string.IsNullOrEmpty(p)).ToList();
        return kept.Count == 0 ? null : string.Join("; ", kept);
    }

    /// <summary>The names of these steps (a step not found keeps the start of its id).</summary>
    public static async Task<Dictionary<Guid, string>> StepNamesAsync(BaseDbContext db, IEnumerable<Guid> ids, CancellationToken ct)
    {
        var wanted = ids.Distinct().ToList();
        var found = await db.Set<StepEntity>().AsNoTracking().Where(s => wanted.Contains(s.Id))
            .Select(s => new { s.Id, s.Name }).ToListAsync(ct);
        var names = found.ToDictionary(s => s.Id, s => s.Name);
        foreach (var id in wanted) names.TryAdd(id, Short(id));
        return names;
    }

    /// <summary>An id as the log shows an entity it cannot name: its first eight characters.</summary>
    public static string Short(Guid id) => id.ToString("D")[..8];
}
