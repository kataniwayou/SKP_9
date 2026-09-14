using System.Text.Json;
using BaseApi.Service.Features.Orchestration.Projection;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// What the writer leaves in the store for a workflow that names caches.
/// <para>
/// The assertions are about resulting keys rather than calls, because the contract cleanup depends
/// on is exactly that: a root naming the dictionaries, each dictionary naming its entries, and every
/// entry present under the address a processor will be handed.
/// </para>
/// </summary>
public sealed class CacheProjectionWriteTests
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

    private static async Task<InMemoryL2> WriteAsync(WorkflowL1 definition)
    {
        var l2 = new InMemoryL2();
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 9, 14, 12, 0, 0, TimeSpan.Zero));

        await new L2ProjectionWriter(l2.Multiplexer, clock)
            .WriteAsync(definition, TestContext.Current.CancellationToken);

        return l2;
    }

    [Fact]
    public async Task EveryEntryIsWrittenUnderItsOwnKey()
    {
        var l2 = await WriteAsync(Definition(
            new CacheL1("sk-whitelist", new() { ["acme"] = "1", ["alphabeta"] = "2" })));

        Assert.Equal("1", l2.Value(L2ProjectionKeys.CacheEntry(W, "sk-whitelist", "acme")));
        Assert.Equal("2", l2.Value(L2ProjectionKeys.CacheEntry(W, "sk-whitelist", "alphabeta")));
    }

    [Fact]
    public async Task TheCacheRootListsItsKeys()
    {
        var l2 = await WriteAsync(Definition(
            new CacheL1("sk-whitelist", new() { ["acme"] = "1", ["alphabeta"] = "2" })));

        var listed = JsonSerializer.Deserialize<List<string>>(
            l2.Value(L2ProjectionKeys.Cache(W, "sk-whitelist"))!, MessagingJson.Options)!;

        Assert.Equal(new[] { "acme", "alphabeta" }, listed.OrderBy(k => k, StringComparer.Ordinal));
    }

    [Fact]
    public async Task TheWorkflowRootRecordsEveryCacheRoot()
    {
        var l2 = await WriteAsync(Definition(
            new CacheL1("sk-whitelist", new() { ["acme"] = "1" }),
            new CacheL1("other-list", new() { ["beta"] = "2" })));

        var root = JsonSerializer.Deserialize<WorkflowRootProjection>(
            l2.Value(L2ProjectionKeys.Root(W))!, MessagingJson.Options)!;

        Assert.NotNull(root.CacheRoots);
        Assert.Equal(
            new[] { "other-list", "sk-whitelist" },
            root.CacheRoots!.OrderBy(r => r, StringComparer.Ordinal));
    }

    [Fact]
    public async Task AnEmptyDictionaryStillWritesItsRootWithAnEmptyList()
    {
        // "Allow nothing" must be distinguishable from "no cache": the root key exists and lists
        // nothing, rather than being absent.
        var l2 = await WriteAsync(Definition(new CacheL1("sk-whitelist", new())));

        Assert.True(l2.Has(L2ProjectionKeys.Cache(W, "sk-whitelist")));
        Assert.Equal("[]", l2.Value(L2ProjectionKeys.Cache(W, "sk-whitelist")));
    }

    [Fact]
    public async Task AWorkflowWithNoCachesWritesNoCacheKeys()
    {
        var l2 = await WriteAsync(Definition());

        Assert.DoesNotContain(l2.Keys(), k => k.Contains(":cache:"));
    }

    [Fact]
    public async Task AWorkflowWithNoCachesRecordsAnEmptyRootList()
    {
        // Empty rather than null, so cleanup reads one shape from anything this writer produced.
        var l2 = await WriteAsync(Definition());

        var root = JsonSerializer.Deserialize<WorkflowRootProjection>(
            l2.Value(L2ProjectionKeys.Root(W))!, MessagingJson.Options)!;

        Assert.NotNull(root.CacheRoots);
        Assert.Empty(root.CacheRoots!);
    }

    [Fact]
    public async Task TheSameCacheNamedTwiceIsWrittenOnce()
    {
        // The junction's composite key makes this unreachable, but the writer should not depend on a
        // constraint two layers away.
        var l2 = await WriteAsync(Definition(
            new CacheL1("sk-whitelist", new() { ["acme"] = "1" }),
            new CacheL1("sk-whitelist", new() { ["acme"] = "1" })));

        var root = JsonSerializer.Deserialize<WorkflowRootProjection>(
            l2.Value(L2ProjectionKeys.Root(W))!, MessagingJson.Options)!;

        Assert.Single(root.CacheRoots!);
    }
}
