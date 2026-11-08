using System.Text.Json;
using BaseApi.Service.Features.Orchestration.Projection;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// What a cache-only write leaves in the store for a workflow that is already projected: one root's
/// dictionary aligned with the row, and nothing else the start wrote touched.
/// </summary>
public sealed class CacheRefreshWriteTests
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

    private static L2ProjectionWriter Writer(InMemoryL2 l2) => new(l2.Multiplexer, FakeStepRows.Everything());

    private static async Task<InMemoryL2> StartedAsync(params CacheL1[] caches)
    {
        var l2 = new InMemoryL2();
        await Writer(l2).WriteAsync(Definition(caches), TestContext.Current.CancellationToken);
        return l2;
    }

    [Fact]
    public async Task ANewItemIsWrittenAndAKeptOneOverwritten()
    {
        var l2 = await StartedAsync(new CacheL1("artists", new() { ["acme"] = "Acme" }));

        await Writer(l2).WriteCacheAsync(W,
            new CacheL1("artists", new() { ["acme"] = "Acme (Approved)", ["beta"] = "Beta" }),
            TestContext.Current.CancellationToken);

        Assert.Equal("Acme (Approved)", l2.Value(L2ProjectionKeys.CacheEntry(W, "artists", "acme")));
        Assert.Equal("Beta", l2.Value(L2ProjectionKeys.CacheEntry(W, "artists", "beta")));
    }

    [Fact]
    public async Task AnItemNoLongerHeldIsDeleted()
    {
        var l2 = await StartedAsync(new CacheL1("artists", new() { ["acme"] = "Acme", ["gone"] = "Gone" }));

        await Writer(l2).WriteCacheAsync(W,
            new CacheL1("artists", new() { ["acme"] = "Acme" }), TestContext.Current.CancellationToken);

        Assert.False(l2.Has(L2ProjectionKeys.CacheEntry(W, "artists", "gone")));
    }

    [Fact]
    public async Task TheRootListsTheNewKeys()
    {
        var l2 = await StartedAsync(new CacheL1("artists", new() { ["acme"] = "Acme", ["gone"] = "Gone" }));

        await Writer(l2).WriteCacheAsync(W,
            new CacheL1("artists", new() { ["acme"] = "Acme", ["beta"] = "Beta" }),
            TestContext.Current.CancellationToken);

        var listed = JsonSerializer.Deserialize<List<string>>(
            l2.Value(L2ProjectionKeys.Cache(W, "artists"))!, MessagingJson.Options)!;
        Assert.Equal(new[] { "acme", "beta" }, listed.Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task EmptiedItemsLeaveTheRootListingNothing()
    {
        // "Allow nothing", which a processor tells apart from a dictionary never projected.
        var l2 = await StartedAsync(new CacheL1("artists", new() { ["acme"] = "Acme" }));

        await Writer(l2).WriteCacheAsync(W, new CacheL1("artists", new()), TestContext.Current.CancellationToken);

        Assert.Equal("[]", l2.Value(L2ProjectionKeys.Cache(W, "artists")));
        Assert.False(l2.Has(L2ProjectionKeys.CacheEntry(W, "artists", "acme")));
    }

    [Fact]
    public async Task EverythingElseTheStartWroteIsLeftAlone()
    {
        var l2 = await StartedAsync(
            new CacheL1("artists", new() { ["acme"] = "Acme" }),
            new CacheL1("labels", new() { ["one"] = "One" }));
        var store = l2.HashValue(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.StoreField);
        var roots = l2.HashValue(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.RootsField);

        await Writer(l2).WriteCacheAsync(W,
            new CacheL1("artists", new() { ["beta"] = "Beta" }), TestContext.Current.CancellationToken);

        Assert.Equal(store, l2.HashValue(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.StoreField));
        Assert.Equal(roots, l2.HashValue(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.RootsField));
        Assert.Equal("One", l2.Value(L2ProjectionKeys.CacheEntry(W, "labels", "one")));
    }

    [Fact]
    public async Task ARootTheWorkflowNeverProjectedIsNotWritten()
    {
        // Bound after the start: a binding change, which waits for the next start.
        var l2 = await StartedAsync(new CacheL1("labels", new() { ["one"] = "One" }));

        var written = await Writer(l2).WriteCacheAsync(W,
            new CacheL1("artists", new() { ["acme"] = "Acme" }), TestContext.Current.CancellationToken);

        Assert.False(written);
        Assert.DoesNotContain(l2.Keys(), k => k.Contains(":cache:artists"));
    }

    [Fact]
    public async Task AWorkflowNeverStartedIsNotWritten()
    {
        var l2 = new InMemoryL2();

        var written = await Writer(l2).WriteCacheAsync(W,
            new CacheL1("artists", new() { ["acme"] = "Acme" }), TestContext.Current.CancellationToken);

        Assert.False(written);
        Assert.Empty(l2.Keys());
    }

    [Fact]
    public async Task WritingTheSameItemsTwiceLeavesTheSameStore()
    {
        // A redelivered refresh runs the write again.
        var l2 = await StartedAsync(new CacheL1("artists", new() { ["acme"] = "Acme" }));
        var next = new CacheL1("artists", new() { ["beta"] = "Beta" });

        await Writer(l2).WriteCacheAsync(W, next, TestContext.Current.CancellationToken);
        var once = l2.Snapshot();
        await Writer(l2).WriteCacheAsync(W, next, TestContext.Current.CancellationToken);

        Assert.Equal(once, l2.Snapshot());
    }
}
