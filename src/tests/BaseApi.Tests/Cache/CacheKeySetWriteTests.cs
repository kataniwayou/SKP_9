using BaseApi.Service.Features.Orchestration.Projection;
using BaseApi.Service.Features.Workflow.Delete;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// The cache key names live in a Redis set; the cache root is only the "was projected" marker (<c>[]</c>).
/// <c>ApplyCacheKeysAsync</c> adds or drops single keys without touching the rest.
/// </summary>
public sealed class CacheKeySetWriteTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly string Root = L2ProjectionKeys.Cache(W, "artists");
    private static readonly string KeySet = L2ProjectionKeys.CacheKeySet(W, "artists");

    private static WorkflowL1 Definition(params CacheL1[] caches) => new(
        WorkflowId: W,
        EntryStepIds: [S],
        Steps: [new StepL1(S, EntryCondition: 0, ProcessorId: P, Payload: "{}", NextStepIds: [])],
        Caches: caches.ToList());

    private static L2ProjectionWriter Writer(InMemoryL2 l2) => new(l2.Multiplexer, FakeStepRows.Everything());

    private static async Task<InMemoryL2> StartedAsync(params CacheL1[] caches)
    {
        var l2 = new InMemoryL2();
        await Writer(l2).WriteAsync(Definition(caches), TestContext.Current.CancellationToken);
        return l2;
    }

    private static Dictionary<string, string?> Delta(params (string Key, string? Value)[] pairs)
        => pairs.ToDictionary(p => p.Key, p => p.Value, StringComparer.Ordinal);

    /// <summary>The pre-deploy shape: key names as a JSON list at the root, no set.</summary>
    private static async Task MakeLegacyAsync(InMemoryL2 l2, string json)
    {
        await l2.Db.KeyDeleteAsync(KeySet);
        await l2.Db.StringSetAsync(Root, json);
    }

    [Fact]
    public void KeySetNameIsTheRootWithAKeysSuffix()
        => Assert.Equal($"skp:wf:{W}:cache:artists::keys", KeySet);

    [Fact]
    public async Task StartWritesKeySetAndEmptyMarkerRoot()
    {
        var l2 = await StartedAsync(new CacheL1("artists", new() { ["acme"] = "1", ["beta"] = "2" }));

        Assert.Equal("[]", l2.Value(Root));
        Assert.Equal(new[] { "acme", "beta" }, l2.Members(KeySet));
        Assert.Equal("1", l2.Value(L2ProjectionKeys.CacheEntry(W, "artists", "acme")));
    }

    [Fact]
    public async Task ApplyAddsEntryAndSetMember()
    {
        var l2 = await StartedAsync(new CacheL1("artists", new() { ["acme"] = "1" }));

        var ok = await Writer(l2).ApplyCacheKeysAsync(W, "artists", Delta(("beta", "2")),
            TestContext.Current.CancellationToken);

        Assert.True(ok);
        Assert.Equal("2", l2.Value(L2ProjectionKeys.CacheEntry(W, "artists", "beta")));
        Assert.Equal(new[] { "acme", "beta" }, l2.Members(KeySet));
        Assert.Equal("1", l2.Value(L2ProjectionKeys.CacheEntry(W, "artists", "acme")));
    }

    [Fact]
    public async Task ApplyNullDeletesEntryAndSetMember()
    {
        var l2 = await StartedAsync(new CacheL1("artists", new() { ["acme"] = "1", ["beta"] = "2" }));

        await Writer(l2).ApplyCacheKeysAsync(W, "artists", Delta(("beta", null)),
            TestContext.Current.CancellationToken);

        Assert.False(l2.Has(L2ProjectionKeys.CacheEntry(W, "artists", "beta")));
        Assert.Equal(new[] { "acme" }, l2.Members(KeySet));
        Assert.Equal("[]", l2.Value(Root));
    }

    [Fact]
    public async Task ApplyOnUnprojectedRootReturnsFalseAndWritesNothing()
    {
        var l2 = await StartedAsync(new CacheL1("labels", new() { ["one"] = "1" }));
        var before = l2.Snapshot();

        var ok = await Writer(l2).ApplyCacheKeysAsync(W, "artists", Delta(("acme", "1")),
            TestContext.Current.CancellationToken);

        Assert.False(ok);
        Assert.Equal(before, l2.Snapshot());
    }

    [Fact]
    public async Task ApplySeedsSetFromLegacyJsonRoot()
    {
        var l2 = await StartedAsync(new CacheL1("artists", new() { ["a"] = "1", ["b"] = "2" }));
        await MakeLegacyAsync(l2, "[\"a\",\"b\"]");

        await Writer(l2).ApplyCacheKeysAsync(W, "artists", Delta(("c", "3")),
            TestContext.Current.CancellationToken);

        Assert.Equal(new[] { "a", "b", "c" }, l2.Members(KeySet));
        Assert.Equal("[]", l2.Value(Root));
    }

    [Fact]
    public async Task StartLeftoversReadFromSet()
    {
        var l2 = await StartedAsync(new CacheL1("artists", new() { ["a"] = "1", ["b"] = "2" }));

        await Writer(l2).WriteAsync(Definition(new CacheL1("artists", new() { ["a"] = "1" })),
            TestContext.Current.CancellationToken);

        Assert.False(l2.Has(L2ProjectionKeys.CacheEntry(W, "artists", "b")));
        Assert.Equal(new[] { "a" }, l2.Members(KeySet));
    }

    [Fact]
    public async Task StartLeftoversFallBackToLegacyJsonRoot()
    {
        var l2 = await StartedAsync(new CacheL1("artists", new() { ["a"] = "1", ["b"] = "2" }));
        await MakeLegacyAsync(l2, "[\"a\",\"b\"]");

        await Writer(l2).WriteAsync(Definition(new CacheL1("artists", new() { ["a"] = "1" })),
            TestContext.Current.CancellationToken);

        Assert.False(l2.Has(L2ProjectionKeys.CacheEntry(W, "artists", "b")));
    }

    [Fact]
    public async Task ADroppedRootLosesItsRootSetAndEntries()
    {
        var l2 = await StartedAsync(new CacheL1("artists", new() { ["a"] = "1" }));

        await Writer(l2).WriteAsync(Definition(), TestContext.Current.CancellationToken);

        Assert.DoesNotContain(l2.Keys(), k => k.Contains(":cache:"));
        Assert.Empty(l2.Members(KeySet));
    }

    [Fact]
    public async Task FullRefreshUsesSet()
    {
        var l2 = await StartedAsync(new CacheL1("artists", new() { ["a"] = "1", ["b"] = "2" }));

        var ok = await Writer(l2).WriteCacheAsync(W, new CacheL1("artists", new() { ["a"] = "9", ["c"] = "3" }),
            TestContext.Current.CancellationToken);

        Assert.True(ok);
        Assert.False(l2.Has(L2ProjectionKeys.CacheEntry(W, "artists", "b")));
        Assert.Equal(new[] { "a", "c" }, l2.Members(KeySet));
        Assert.Equal("[]", l2.Value(Root));
        Assert.Equal("9", l2.Value(L2ProjectionKeys.CacheEntry(W, "artists", "a")));
    }

    [Fact]
    public async Task EmptiedFullRefreshLeavesMarkerAndNoSet()
    {
        var l2 = await StartedAsync(new CacheL1("artists", new() { ["a"] = "1" }));

        await Writer(l2).WriteCacheAsync(W, new CacheL1("artists", new()), TestContext.Current.CancellationToken);

        Assert.Equal("[]", l2.Value(Root));
        Assert.Empty(l2.Members(KeySet));
        Assert.False(l2.Has(L2ProjectionKeys.CacheEntry(W, "artists", "a")));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DeletingTheWorkflowRemovesTheSetEntriesAndRoot(bool legacy)
    {
        var l2 = await StartedAsync(new CacheL1("artists", new() { ["a"] = "1", ["b"] = "2" }));
        if (legacy)
        {
            await MakeLegacyAsync(l2, "[\"a\",\"b\"]");
        }

        await new RedisWorkflowRunGuard(l2.Multiplexer)
            .EndDeleteAsync(W, deleted: true, [], TestContext.Current.CancellationToken);

        Assert.DoesNotContain(l2.Keys(), k => k.Contains(":cache:"));
        Assert.Empty(l2.Members(KeySet));
    }

    [Fact]
    public async Task ApplyingTheSameDeltaTwiceLeavesTheSameStore()
    {
        var l2 = await StartedAsync(new CacheL1("artists", new() { ["a"] = "1", ["b"] = "2" }));
        var delta = Delta(("c", "3"), ("b", null));

        await Writer(l2).ApplyCacheKeysAsync(W, "artists", delta, TestContext.Current.CancellationToken);
        var once = l2.Snapshot();
        await Writer(l2).ApplyCacheKeysAsync(W, "artists", delta, TestContext.Current.CancellationToken);

        Assert.Equal(once, l2.Snapshot());
    }
}
