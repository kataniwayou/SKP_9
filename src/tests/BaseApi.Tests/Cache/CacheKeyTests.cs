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
            "skp:11111111-1111-1111-1111-111111111111:cache:sk-whitelist",
            L2ProjectionKeys.Cache(W, "sk-whitelist"));
    }

    [Fact]
    public void AnEntryIsItsCacheRootPlusTheKey()
    {
        Assert.Equal(
            "skp:11111111-1111-1111-1111-111111111111:cache:sk-whitelist:acme",
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

    [Fact]
    public void ACacheKeyCannotCollideWithAStepKey()
    {
        // Both are skp:{workflowId}:… — the discriminator is that a step key's third segment is a
        // GUID and a cache key's is the literal "cache", which CacheEntity's validator guarantees no
        // root can impersonate, since it refuses a root containing ':'.
        var step = L2ProjectionKeys.Step(W, Guid.Parse("22222222-2222-2222-2222-222222222222"));

        Assert.NotEqual(step, L2ProjectionKeys.Cache(W, "sk-whitelist"));
        Assert.StartsWith($"skp:{W:D}:cache:", L2ProjectionKeys.Cache(W, "sk-whitelist"));
    }

    [Fact]
    public void ARootProjectionWrittenBeforeCachesExistedReadsAsNoCaches()
    {
        // The compatibility guarantee cleanup depends on: an in-flight workflow projected by the
        // previous writer has no cacheRoots field at all, and must deserialize to null rather than
        // throwing, so its graph can still be removed.
        // The liveness names are timestamp/interval/status — see LivenessProjection's
        // JsonPropertyName attributes. Inventing them here would make this test pass against a
        // record that never round-trips.
        const string legacy = """
            {"entryStepIds":[],"stepIds":[],"cron":null,
             "liveness":{"timestamp":"2026-08-21T12:00:00Z","interval":0,"status":"Pending"}}
            """;

        var root = System.Text.Json.JsonSerializer.Deserialize<WorkflowRootProjection>(
            legacy, global::Messaging.Contracts.MessagingJson.Options);

        Assert.NotNull(root);
        Assert.Null(root!.CacheRoots);
    }
}
