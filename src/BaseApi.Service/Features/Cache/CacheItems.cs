using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Cache;

/// <summary>
/// The cache's item rows as the rest of the service sees them: read as pairs ordered by key, turned into
/// the dictionary the projection takes, and written as a diff.
/// </summary>
internal static class CacheItems
{
    /// <summary>The rows as pairs, ordered by key (ordinal): the table has no order of its own.</summary>
    public static List<CacheItemDto> ToDtos(IEnumerable<CacheItem> rows) =>
        rows.OrderBy(r => r.Key, StringComparer.Ordinal).Select(r => new CacheItemDto(r.Key, r.Value)).ToList();

    /// <summary>The rows as the dictionary <c>CacheL1</c> carries.</summary>
    public static Dictionary<string, string> ToDictionary(IEnumerable<CacheItem> rows) =>
        rows.ToDictionary(r => r.Key, r => r.Value, StringComparer.Ordinal);

    /// <summary>The pairs as the dictionary <c>CacheL1</c> carries; the validator has refused a key twice.</summary>
    public static Dictionary<string, string> ToDictionary(IEnumerable<CacheItemDto> items) =>
        items.ToDictionary(i => i.Key, i => i.Value, StringComparer.Ordinal);

    /// <summary>
    /// Makes <paramref name="target"/>'s loaded rows hold exactly <paramref name="items"/>: a kept key's value
    /// is set in place, a dropped key's row is removed (EF deletes the orphan), a new key is added. Never a
    /// replaced list: a new row with a kept key would be a second tracked instance of one primary key.
    /// <para>
    /// When anything changed, an otherwise unchanged cache is marked Modified, so its <c>UpdatedAt</c> and
    /// <c>xmin</c> move with its items — a board holding the old stamp then sees the edit.
    /// </para>
    /// </summary>
    /// <returns>Whether any row changed.</returns>
    public static bool Apply(DbContext db, CacheEntity target, IReadOnlyList<CacheItemDto> items)
    {
        var wanted = ToDictionary(items);
        var changed = false;

        foreach (var row in target.Items.ToList())
        {
            if (!wanted.TryGetValue(row.Key, out var value))
            {
                target.Items.Remove(row);
                changed = true;
            }
            else if (row.Value != value)
            {
                row.Value = value;
                changed = true;
            }
        }

        var kept = target.Items.Select(r => r.Key).ToHashSet(StringComparer.Ordinal);
        foreach (var item in items.Where(i => !kept.Contains(i.Key)))
        {
            target.Items.Add(new CacheItem { CacheId = target.Id, Key = item.Key, Value = item.Value });
            changed = true;
        }

        if (changed && db.Entry(target).State == EntityState.Unchanged)
        {
            db.Entry(target).State = EntityState.Modified;
        }

        return changed;
    }
}
