namespace BaseApi.Service.Features.Cache;

/// <summary>
/// One entry of a cache's dictionary: a row of <c>cache_items</c>, keyed by its cache and its key, so the
/// database itself refuses a key twice.
/// <para>
/// Like the junctions it deliberately does not derive from <c>BaseEntity</c>: it has no audit fields and
/// no <c>xmin</c> of its own. A change to it marks its cache Modified instead (<see cref="CacheItems.Apply"/>),
/// so the cache's <c>UpdatedAt</c> and <c>xmin</c> answer for its items.
/// </para>
/// </summary>
public sealed class CacheItem
{
    public Guid CacheId { get; set; }

    /// <summary>Part of the L2 address (<c>…:cache:{root}:{key}</c>): non-empty, colon-free, bounded.</summary>
    public string Key { get; set; } = string.Empty;

    public string Value { get; set; } = string.Empty;
}
