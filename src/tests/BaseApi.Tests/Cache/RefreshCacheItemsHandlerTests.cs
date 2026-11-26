using System.Text.Json;
using BaseApi.Service;
using BaseApi.Service.Features.Cache;
using BaseApi.Service.Features.Orchestration.Messaging;
using BaseApi.Service.Features.Orchestration.Projection;
using BaseApi.Service.Features.Workflow;
using BaseApi.Service.Features.Workflow.Delete;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// The per-key refresh: each touched key's CURRENT row is applied to every running workflow bound to the
/// cache. The row is read when the message is handled, so order and redelivery cannot leave a stale value.
/// Needs a real Postgres: the item reads are raw SQL.
/// </summary>
[Collection("Postgres")]
public sealed class RefreshCacheItemsHandlerTests(PostgresFixture fixture)
{
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly InMemoryL2 _l2 = new();
    private readonly FakeRunGuard _guard = new();

    private sealed class FakeRunGuard : IWorkflowRunGuard
    {
        public HashSet<Guid> Deleting { get; } = [];

        public Task<bool> IsLiveAsync(Guid workflowId, CancellationToken ct) => throw new NotSupportedException();
        public Task<bool> IsDeletingAsync(Guid workflowId, CancellationToken ct) => Task.FromResult(Deleting.Contains(workflowId));
        public Task<bool> IsDeletionRunningAsync(Guid workflowId, CancellationToken ct) => throw new NotSupportedException();
        public Task BeginDeleteAsync(Guid workflowId, CancellationToken ct) => throw new NotSupportedException();
        public Task EndDeleteAsync(Guid workflowId, bool deleted, IReadOnlyCollection<Guid> deletedSteps, CancellationToken ct)
            => throw new NotSupportedException();
    }

    /// <summary>A cache whose rows hold <paramref name="items"/>.</summary>
    private async Task<(Guid Id, string Root)> CacheAsync(params (string k, string v)[] items)
    {
        PostgresFixture.SkipUnlessEnabled();
        await using var db = fixture.NewContext();
        var cache = new CacheEntity { Name = "c", Version = "1.0.0", Root = $"r{Guid.NewGuid():N}" };
        db.Set<CacheEntity>().Add(cache);
        await db.SaveChangesAsync(Ct);
        foreach (var (k, v) in items)
        {
            db.Set<CacheItem>().Add(new CacheItem { CacheId = cache.Id, Key = k, Value = v });
        }
        await db.SaveChangesAsync(Ct);
        return (cache.Id, cache.Root);
    }

    /// <summary>A workflow bound to the cache, started while the store held <paramref name="started"/>.</summary>
    private async Task<Guid> StartedAsync(Guid cache, string root, Dictionary<string, string> started, bool live = true)
    {
        Guid workflowId;
        await using (var db = fixture.NewContext())
        {
            var workflow = new WorkflowEntity { Name = "w", Version = "1.0.0" };
            db.Set<WorkflowEntity>().Add(workflow);
            await db.SaveChangesAsync(Ct);
            db.Set<WorkflowCaches>().Add(new WorkflowCaches { WorkflowId = workflow.Id, CacheId = cache });
            await db.SaveChangesAsync(Ct);
            workflowId = workflow.Id;
        }

        await new L2ProjectionWriter(_l2.Multiplexer, FakeStepRows.Everything()).WriteAsync(new WorkflowL1(
            WorkflowId: workflowId,
            EntryStepIds: [S],
            Steps: [new StepL1(S, EntryCondition: 0, ProcessorId: P, Payload: "{}", NextStepIds: [])],
            Caches: [new CacheL1(root, started)]), Ct);

        if (live)
        {
            await new L2LiveSet(_l2.Multiplexer).AddAsync(workflowId);
        }

        return workflowId;
    }

    private async Task HandleAsync(RefreshCacheItems message)
    {
        await using var db = fixture.NewContext();
        await Handler(db).HandleAsync(JsonSerializer.SerializeToUtf8Bytes(message, MessagingJson.Options), Ct);
    }

    private RefreshCacheItemsHandler Handler(AppDbContext db) => new(
        db, new CacheItemsStore(db, TimeProvider.System, new HttpContextAccessor()),
        new L2LiveSet(_l2.Multiplexer), new L2ProjectionWriter(_l2.Multiplexer, FakeStepRows.Everything()),
        _guard, NullLogger<RefreshCacheItemsHandler>.Instance);

    private async Task SetRowAsync(Guid cache, string key, string? value)
    {
        await using var db = fixture.NewContext();
        await db.Database.ExecuteSqlRawAsync("DELETE FROM cache_items WHERE cache_id = {0} AND key = {1}", [cache, key], Ct);
        if (value is not null)
        {
            await db.Database.ExecuteSqlRawAsync(
                "INSERT INTO cache_items (cache_id, key, value) VALUES ({0}, {1}, {2})", [cache, key, value], Ct);
        }
    }

    private string? Entry(Guid workflow, string root, string key) => _l2.Value(L2ProjectionKeys.CacheEntry(workflow, root, key));

    [Fact]
    public async Task AppliesCurrentDbStateForTouchedKeys()
    {
        var (cache, root) = await CacheAsync(("a", "1"), ("b", "2"), ("c", "3"));
        var workflow = await StartedAsync(cache, root, new() { ["a"] = "old" });

        await HandleAsync(new RefreshCacheItems(cache, ["a", "b"]));

        Assert.Equal("1", Entry(workflow, root, "a"));
        Assert.Equal("2", Entry(workflow, root, "b"));
        Assert.Null(Entry(workflow, root, "c")); // not touched, not carried
    }

    [Fact]
    public async Task RemovedKeyIsDeletedFromRedis()
    {
        var (cache, root) = await CacheAsync(("a", "1"));
        var workflow = await StartedAsync(cache, root, new() { ["a"] = "1", ["gone"] = "x" });

        await HandleAsync(new RefreshCacheItems(cache, ["gone"]));

        Assert.Null(Entry(workflow, root, "gone"));
        Assert.Equal("1", Entry(workflow, root, "a"));
    }

    [Fact]
    public async Task OutOfOrderMessagesEndAtDbState()
    {
        var (cache, root) = await CacheAsync(("a", "2"));
        var workflow = await StartedAsync(cache, root, new() { ["a"] = "1" });

        // Two edits (a=1 then a=2) were sent; whatever order they arrive in, the row says 2.
        await HandleAsync(new RefreshCacheItems(cache, ["a"]));
        await HandleAsync(new RefreshCacheItems(cache, ["a"]));
        Assert.Equal("2", Entry(workflow, root, "a"));

        await SetRowAsync(cache, "a", "3");
        await HandleAsync(new RefreshCacheItems(cache, ["a"]));
        await HandleAsync(new RefreshCacheItems(cache, ["a"]));
        Assert.Equal("3", Entry(workflow, root, "a"));
    }

    [Fact]
    public async Task StoppedWorkflowUntouched()
    {
        var (cache, root) = await CacheAsync(("a", "2"));
        var workflow = await StartedAsync(cache, root, new() { ["a"] = "1" }, live: false);

        await HandleAsync(new RefreshCacheItems(cache, ["a"]));

        Assert.Equal("1", Entry(workflow, root, "a"));
    }

    [Fact]
    public async Task DeletingWorkflowSkipped()
    {
        var (cache, root) = await CacheAsync(("a", "2"));
        var workflow = await StartedAsync(cache, root, new() { ["a"] = "1" });
        _guard.Deleting.Add(workflow);

        await HandleAsync(new RefreshCacheItems(cache, ["a"]));

        Assert.Equal("1", Entry(workflow, root, "a"));
    }

    [Fact]
    public async Task MissingCacheIsAcknowledged()
    {
        PostgresFixture.SkipUnlessEnabled();

        await HandleAsync(new RefreshCacheItems(Guid.NewGuid(), ["a"]));
    }

    [Fact]
    public async Task EmptyCacheIdParks()
    {
        PostgresFixture.SkipUnlessEnabled();
        await using var db = fixture.NewContext();

        await Assert.ThrowsAsync<JsonException>(() => Handler(db).HandleAsync(
            JsonSerializer.SerializeToUtf8Bytes(new RefreshCacheItems(Guid.Empty, ["a"]), MessagingJson.Options), Ct));
        await Assert.ThrowsAsync<JsonException>(() => Handler(db).HandleAsync("null"u8.ToArray(), Ct));
    }

    [Fact]
    public void ItHandlesTheRefreshItemsMessageType()
    {
        PostgresFixture.SkipUnlessEnabled();
        using var db = fixture.NewContext();

        Assert.Equal(MessageTypes.RefreshCacheItems, Handler(db).MessageType);
    }
}
