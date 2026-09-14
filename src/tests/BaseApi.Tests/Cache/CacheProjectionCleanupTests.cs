using System.Text.Json;
using BaseApi.Service.Features.Orchestration.Projection;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// Stop must leave nothing behind. A cache entry that survives its workflow is unreachable from any
/// later root, so no subsequent stop can find it either — it leaks permanently, one key per entry
/// per run, and it answers lookups for whatever workflow next claims the same root.
/// </summary>
public sealed class CacheProjectionCleanupTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");

    private static WorkflowL1 Definition(params CacheL1[] caches) => new(
        WorkflowId: W,
        EntryStepIds: [S],
        Cron: null,
        Steps: [new StepL1(S, EntryCondition: 0, ProcessorId: P, Payload: "{}", NextStepIds: [])],
        Caches: caches.ToList());

    private static async Task<InMemoryL2> ProjectedAsync(params CacheL1[] caches)
    {
        var l2 = new InMemoryL2();
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 9, 14, 12, 0, 0, TimeSpan.Zero));

        await new L2ProjectionWriter(l2.Multiplexer, clock)
            .WriteAsync(Definition(caches), TestContext.Current.CancellationToken);

        return l2;
    }

    private static Task CleanAsync(InMemoryL2 l2) =>
        new L2Cleanup(l2.Multiplexer).RemoveAsync(W, TestContext.Current.CancellationToken);

    [Fact]
    public async Task EveryCacheKeyIsRemoved()
    {
        var l2 = await ProjectedAsync(
            new CacheL1("sk-whitelist", new() { ["acme"] = "1", ["alphabeta"] = "2" }),
            new CacheL1("other-list", new() { ["beta"] = "3" }));

        await CleanAsync(l2);

        Assert.DoesNotContain(l2.Keys(), k => k.Contains(":cache:"));
    }

    [Fact]
    public async Task TheCacheRootItselfIsRemoved()
    {
        var l2 = await ProjectedAsync(new CacheL1("sk-whitelist", new() { ["acme"] = "1" }));

        await CleanAsync(l2);

        Assert.False(l2.Has(L2ProjectionKeys.Cache(W, "sk-whitelist")));
    }

    [Fact]
    public async Task TheWorkflowRootAndItsStepsGoTooAsBefore()
    {
        var l2 = await ProjectedAsync(new CacheL1("sk-whitelist", new() { ["acme"] = "1" }));

        await CleanAsync(l2);

        Assert.False(l2.Has(L2ProjectionKeys.Root(W)));
        Assert.False(l2.Has(L2ProjectionKeys.Step(W, S)));
    }

    [Fact]
    public async Task ASecondCleanupIsAQuietNoOp()
    {
        // A stop asks for an end state rather than an action, so a redelivery, a repeat, or a stop
        // for something never started must all complete without throwing.
        var l2 = await ProjectedAsync(new CacheL1("sk-whitelist", new() { ["acme"] = "1" }));

        await CleanAsync(l2);
        await CleanAsync(l2);

        Assert.Empty(l2.Keys());
    }

    [Fact]
    public async Task ARootWithNoCacheRootsFieldStillCleansTheGraph()
    {
        // The compatibility case: a workflow projected before caches existed. Its root carries no
        // cacheRoots, and refusing to clean it would strand the graph permanently.
        var l2 = new InMemoryL2();
        var legacyRoot = new WorkflowRootProjection(
            EntryStepIds: [S],
            StepIds: [S],
            Cron: null,
            Liveness: new LivenessProjection(new DateTime(2026, 9, 14, 12, 0, 0, DateTimeKind.Utc), 0, "Pending"));

        await l2.Db.StringSetAsync(
            L2ProjectionKeys.Root(W), JsonSerializer.Serialize(legacyRoot, MessagingJson.Options));
        await l2.Db.StringSetAsync(L2ProjectionKeys.Step(W, S), "{}");

        await CleanAsync(l2);

        Assert.Empty(l2.Keys());
    }

    [Fact]
    public async Task ACacheRootAlreadyGoneDoesNotStopTheRestOfTheRemoval()
    {
        // The entries under a missing cache root are unreachable — nothing records them elsewhere —
        // but everything else must still go, rather than the whole removal aborting on the gap.
        var l2 = await ProjectedAsync(
            new CacheL1("sk-whitelist", new() { ["acme"] = "1" }),
            new CacheL1("other-list", new() { ["beta"] = "2" }));

        await l2.Db.KeyDeleteAsync(L2ProjectionKeys.Cache(W, "sk-whitelist"));

        await CleanAsync(l2);

        Assert.False(l2.Has(L2ProjectionKeys.Root(W)));
        Assert.False(l2.Has(L2ProjectionKeys.CacheEntry(W, "other-list", "beta")));
    }
}
