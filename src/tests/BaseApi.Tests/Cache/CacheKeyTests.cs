using Messaging.Contracts.Projections;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// The cache key format, pinned because two components compose it independently — the writer that
/// stores a dictionary and the operator who pastes an address into a step payload — and nothing at
/// runtime would report a mismatch. A processor handed an address one character different from the
/// one that was written simply misses every lookup, which is indistinguishable from an empty
/// whitelist.
/// </summary>
public sealed class CacheKeyTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");

    [Fact]
    public void TheCacheRootIsTheWorkflowScopeFollowedByTheRoot()
    {
        Assert.Equal(
            "skp:wf:11111111-1111-1111-1111-111111111111:cache:sk-whitelist",
            L2ProjectionKeys.Cache(W, "sk-whitelist"));
    }

    [Fact]
    public void AnEntryIsItsCacheRootPlusTheKey()
    {
        Assert.Equal(
            "skp:wf:11111111-1111-1111-1111-111111111111:cache:sk-whitelist:acme",
            L2ProjectionKeys.CacheEntry(W, "sk-whitelist", "acme"));
    }

    [Fact]
    public void AnEntryKeyIsExactlyItsCacheRootPlusASeparatorAndTheKey()
    {
        // Stated as a relationship rather than two literals, because cleanup reads the key list from
        // the cache root and rebuilds each entry key from it. If the two builders ever disagree,
        // stop would delete keys that were never written and leave the ones that were.
        Assert.Equal(
            L2ProjectionKeys.Cache(W, "sk-whitelist") + ":acme",
            L2ProjectionKeys.CacheEntry(W, "sk-whitelist", "acme"));
    }

}
