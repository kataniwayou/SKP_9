using System.Text.Json;
using BaseApi.Service;
using BaseApi.Service.Features.Cache;
using BaseApi.Service.Features.Orchestration;
using BaseApi.Service.Features.Orchestration.Messaging;
using BaseApi.Service.Features.Orchestration.Projection;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using BaseApi.Service.Features.Workflow;
using Messaging.Transport;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using Xunit;

namespace BaseApi.Tests.Orchestration;

/// <summary>
/// The start message names its caches and the handler reads their rows, so a cache larger than one
/// broker message still starts its workflow, and the Redis write sees the rows as they are at write time.
/// </summary>
[Collection("Postgres")]
public sealed class StartCarriesCacheRefsTests(PostgresFixture fixture) : IAsyncLifetime
{
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");

    private readonly Guid _cache = Guid.NewGuid();
    private readonly string _root = $"big{Guid.NewGuid():N}";
    private readonly InMemoryL2 _l2 = new();
    private AppDbContext _db = null!;

    public async ValueTask InitializeAsync()
    {
        PostgresFixture.SkipUnlessEnabled();
        _db = fixture.NewContext();
        _db.Set<CacheEntity>().Add(new CacheEntity { Id = _cache, Name = "big", Version = "1.0.0", Root = _root });
        await _db.SaveChangesAsync(TestContext.Current.CancellationToken);
    }

    public async ValueTask DisposeAsync()
    {
        if (_db is not null) await _db.DisposeAsync();
    }

    private CacheItemsStore Store() => new(_db, TimeProvider.System, new HttpContextAccessor());

    private static WorkflowL1 Definition(Guid workflow, params CacheRefL1[] refs) => new(
        WorkflowId: workflow,
        EntryStepIds: [S],
        Steps: [new StepL1(S, EntryCondition: 0, ProcessorId: P, Payload: "{}", NextStepIds: [])],
        Caches: [],
        CacheRefs: refs.ToList());

    private Task StartAsync(WorkflowL1 definition) =>
        new StartOrchestrationHandler(
                new L2ProjectionWriter(_l2.Multiplexer, FakeStepRows.Everything()), new L2LiveSet(_l2.Multiplexer),
                Substitute.For<IQueueFanoutPublisher>(), NullLogger<StartOrchestrationHandler>.Instance,
                runGuard: null, db: _db, items: Store())
            .HandleAsync(JsonSerializer.SerializeToUtf8Bytes(new StartOrchestration(definition), MessagingJson.Options),
                TestContext.Current.CancellationToken);

    [Fact]
    public async Task StartMessageCarriesNoItems()
    {
        var rows = Enumerable.Range(0, 10_000).Select(i => new CacheItemDto($"key-{i:D5}", new string('x', 200))).ToList();
        await Store().AppendAsync(_cache, rows, TestContext.Current.CancellationToken);

        var snapshot = new WorkflowGraphSnapshot(NullLogger<WorkflowGraphSnapshot>.Instance);
        var wf = Guid.NewGuid();
        snapshot.Workflows[wf] = new WorkflowReadDto(
            wf, "wf", "1.0.0", null, [S], [], [_cache], DateTime.UtcNow, DateTime.UtcNow, null, null);
        snapshot.Caches[_cache] = new CacheReadDto(
            _cache, "big", "1.0.0", null, _root, 10_000, DateTime.UtcNow, DateTime.UtcNow, null, null);

        var definition = OrchestrationService.ToDefinitionForTests(snapshot, wf);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(new StartOrchestration(definition), MessagingJson.Options);

        Assert.True(bytes.Length < 8 * 1024, $"start message is {bytes.Length} bytes");
        Assert.Empty(definition.Caches);
        var r = Assert.Single(definition.CacheRefs!);
        Assert.Equal(new CacheRefL1(_cache, _root), r);
    }

    [Fact]
    public async Task StartHandlerReadsRowsAtWriteTime()
    {
        var workflow = Guid.NewGuid();
        await Store().AppendAsync(_cache, [new CacheItemDto("acme", "Acme")], TestContext.Current.CancellationToken);
        var definition = Definition(workflow, new CacheRefL1(_cache, _root));

        await Store().AppendAsync(_cache, [new CacheItemDto("late", "Late")], TestContext.Current.CancellationToken);
        await StartAsync(definition);

        Assert.Equal("Acme", _l2.Value(L2ProjectionKeys.CacheEntry(workflow, _root, "acme")));
        Assert.Equal("Late", _l2.Value(L2ProjectionKeys.CacheEntry(workflow, _root, "late")));
    }

    [Fact]
    public async Task StartHandlerSkipsVanishedCache()
    {
        var workflow = Guid.NewGuid();
        var gone = new CacheRefL1(Guid.NewGuid(), $"gone{Guid.NewGuid():N}");

        await StartAsync(Definition(workflow, new CacheRefL1(_cache, _root), gone));

        Assert.Equal($"[\"{_root}\"]", _l2.HashValue(L2ProjectionKeys.Workflow(workflow), L2ProjectionKeys.RootsField));
        Assert.False(_l2.Has(L2ProjectionKeys.Cache(workflow, gone.Root)));
    }
}
