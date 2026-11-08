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
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// Which workflows a cache's refresh reaches: the running ones that projected it, and no other. The
/// row is read when the message is handled, so the store follows the database rather than the message.
/// </summary>
public sealed class RefreshCacheHandlerTests : IAsyncLifetime
{
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");

    private readonly Guid _cache = Guid.NewGuid();
    private readonly InMemoryL2 _l2 = new();
    private readonly FakeRunGuard _guard = new();
    private AppDbContext _db = null!;

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

    public async ValueTask InitializeAsync()
    {
        _db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase($"refresh-cache-{Guid.NewGuid():N}")
            .Options);

        _db.Set<CacheEntity>().Add(new CacheEntity
        {
            Id = _cache, Name = "artists", Version = "1.0.0", Root = "artists",
            Items = """{"acme":"Acme (Approved)","beta":"Beta"}""",
        });
        await _db.SaveChangesAsync(TestContext.Current.CancellationToken);
    }

    public async ValueTask DisposeAsync() => await _db.DisposeAsync();

    /// <summary>A workflow bound to the cache and started while the row held only <c>acme</c>.</summary>
    private async Task<Guid> StartedAsync(bool live = true)
    {
        var workflow = Guid.NewGuid();
        _db.Set<WorkflowCaches>().Add(new WorkflowCaches { WorkflowId = workflow, CacheId = _cache });
        await _db.SaveChangesAsync(TestContext.Current.CancellationToken);

        await new L2ProjectionWriter(_l2.Multiplexer, FakeStepRows.Everything()).WriteAsync(new WorkflowL1(
            WorkflowId: workflow,
            EntryStepIds: [S],
            Cron: null,
            Steps: [new StepL1(S, EntryCondition: 0, ProcessorId: P, Payload: "{}", NextStepIds: [])],
            Caches: [new CacheL1("artists", new() { ["acme"] = "Acme" })]), TestContext.Current.CancellationToken);

        if (live)
        {
            await new L2LiveSet(_l2.Multiplexer).AddAsync(workflow);
        }

        return workflow;
    }

    private Task HandleAsync(Guid cacheId) =>
        new RefreshCacheHandler(
                _db, new L2LiveSet(_l2.Multiplexer), new L2ProjectionWriter(_l2.Multiplexer, FakeStepRows.Everything()),
                _guard, NullLogger<RefreshCacheHandler>.Instance)
            .HandleAsync(JsonSerializer.SerializeToUtf8Bytes(new RefreshCache(cacheId), MessagingJson.Options),
                TestContext.Current.CancellationToken);

    private string? Entry(Guid workflow, string key) => _l2.Value(L2ProjectionKeys.CacheEntry(workflow, "artists", key));

    [Fact]
    public void ItHandlesTheRefreshMessageType()
    {
        var handler = new RefreshCacheHandler(
            _db, new L2LiveSet(_l2.Multiplexer), new L2ProjectionWriter(_l2.Multiplexer, FakeStepRows.Everything()),
            _guard, NullLogger<RefreshCacheHandler>.Instance);

        Assert.Equal(MessageTypes.RefreshCache, handler.MessageType);
    }

    [Fact]
    public async Task ARunningWorkflowGetsTheRowsItems()
    {
        var workflow = await StartedAsync();

        await HandleAsync(_cache);

        Assert.Equal("Acme (Approved)", Entry(workflow, "acme"));
        Assert.Equal("Beta", Entry(workflow, "beta"));
    }

    [Fact]
    public async Task EveryRunningWorkflowBoundToTheCacheIsRefreshed()
    {
        var first = await StartedAsync();
        var second = await StartedAsync();

        await HandleAsync(_cache);

        Assert.Equal("Beta", Entry(first, "beta"));
        Assert.Equal("Beta", Entry(second, "beta"));
    }

    [Fact]
    public async Task AStoppedWorkflowIsLeftForItsNextStart()
    {
        var workflow = await StartedAsync(live: false);

        await HandleAsync(_cache);

        Assert.Equal("Acme", Entry(workflow, "acme"));
        Assert.Null(Entry(workflow, "beta"));
    }

    [Fact]
    public async Task AWorkflowBeingDeletedIsLeftAlone()
    {
        var workflow = await StartedAsync();
        _guard.Deleting.Add(workflow);

        await HandleAsync(_cache);

        Assert.Null(Entry(workflow, "beta"));
    }

    [Fact]
    public async Task ARunningWorkflowNotBoundToTheCacheIsLeftAlone()
    {
        var other = Guid.NewGuid();
        await new L2LiveSet(_l2.Multiplexer).AddAsync(other);

        await HandleAsync(_cache);

        Assert.DoesNotContain(_l2.Keys(), k => k.Contains(other.ToString("D")));
    }

    [Fact]
    public async Task ACacheThatNoLongerExistsIsANoOp()
    {
        var workflow = await StartedAsync();

        await HandleAsync(Guid.NewGuid());

        Assert.Equal("Acme", Entry(workflow, "acme"));
    }

    [Fact]
    public async Task AnUnreadableBodyThrows()
    {
        var handler = new RefreshCacheHandler(
            _db, new L2LiveSet(_l2.Multiplexer), new L2ProjectionWriter(_l2.Multiplexer, FakeStepRows.Everything()),
            _guard, NullLogger<RefreshCacheHandler>.Instance);

        await Assert.ThrowsAsync<JsonException>(() =>
            handler.HandleAsync("null"u8.ToArray(), TestContext.Current.CancellationToken));
    }
}
