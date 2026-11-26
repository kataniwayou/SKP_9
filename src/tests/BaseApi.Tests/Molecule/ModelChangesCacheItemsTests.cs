using System.Text.Json;
using BaseApi.Core.Exceptions.Handlers;
using BaseApi.Core.Services;
using BaseApi.Service;
using BaseApi.Service.Features.Cache;
using BaseApi.Service.Features.Molecule;
using BaseApi.Service.Features.Workflow.Delete;
using BaseApi.Tests.Support;
using FluentValidation;
using Messaging.Transport;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using NSubstitute;
using Xunit;

namespace BaseApi.Tests.Molecule;

/// <summary>
/// <c>POST /model/apply</c> and <c>/model/validate</c> with <c>cache_items</c> append and remove: a Save that edits
/// items stays all-or-none, answers each op's report, and sends the per-key refresh only after the commit.
/// Postgres: the store's set-based SQL.
/// </summary>
[Collection("Postgres")]
public sealed class ModelChangesCacheItemsTests(PostgresFixture fixture) : IAsyncLifetime
{
    private Guid _cache;
    private readonly string _root = $"artists-{Guid.NewGuid():N}";
    private readonly RecordingSender _sender = new();
    private AppDbContext _db = null!;
    private ModelChangeRunner _runner = null!;

    private sealed class RecordingSender : IQueueSender
    {
        public List<(string Queue, string Type, object? Body)> Sent { get; } = [];
        public Exception? Fault { get; set; }
        public Func<Task>? OnSend { get; set; }

        public async Task SendAsync<T>(string queue, string type, T body, CancellationToken ct,
            string? replyTo = null, string? correlationId = null)
        {
            if (Fault is not null) throw Fault;
            if (OnSend is not null) await OnSend();
            Sent.Add((queue, type, body));
        }
    }

    public async ValueTask InitializeAsync()
    {
        PostgresFixture.SkipUnlessEnabled();
        _db = fixture.NewContext();
        var row = new CacheEntity
        {
            Name = "artists", Version = "1.0.0", Description = "the whitelist", Root = _root, ItemCount = 1,
            Items = [new CacheItem { Key = "acme", Value = "Acme" }],
        };
        _db.Set<CacheEntity>().Add(row);
        await _db.SaveChangesAsync(TestContext.Current.CancellationToken);
        _cache = row.Id;
        _db.ChangeTracker.Clear();

        var services = new ServiceCollection();
        services.AddLogging();
        services.AddProblemDetails();
        services.AddSingleton<AppDbContext>(_db);
        services.AddSingleton<BaseApi.Core.Persistence.BaseDbContext>(_db);
        services.AddSingleton<IQueueSender>(_sender);
        services.AddSingleton(TimeProvider.System);
        services.AddSingleton<IHttpContextAccessor>(new HttpContextAccessor());
        services.AddScoped<CacheItemsStore>();
        services.AddScoped<CacheRefreshSender>();
        services.AddSingleton<IValidator<CacheItemsAppendDto>, CacheItemsAppendDtoValidator>();
        services.AddSingleton<IValidator<CacheItemsRemoveDto>, CacheItemsRemoveDtoValidator>();
        services.AddScoped<BaseService<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto>>(
            _ => CacheServiceFactory.Create(_db, _sender));
        services.AddSingleton<IExceptionHandler, NotFoundExceptionHandler>();
        services.AddSingleton<IExceptionHandler, ValidationExceptionHandler>();
        var provider = services.BuildServiceProvider();
        _http = new DefaultHttpContext { RequestServices = provider };

        var guard = Substitute.For<IWorkflowRunGuard>();
        _runner = new ModelChangeRunner(_db, provider, guard, provider.GetServices<IExceptionHandler>(), Options.Create(new JsonOptions()));
    }

    private HttpContext _http = null!;

    public async ValueTask DisposeAsync()
    {
        if (_db is not null) await _db.DisposeAsync();
    }

    private static readonly CancellationToken Ct = TestContext.Current.CancellationToken;

    private static JsonElement Json(object o) => JsonSerializer.SerializeToElement(o, new JsonSerializerOptions(JsonSerializerDefaults.Web));

    private static ModelChangeDto Append(Guid cache, DateTime? readAt = null, params (string K, string V)[] items) =>
        new("append", "cache_items", Guid.NewGuid(), Json(new { cacheId = cache, items = items.Select(i => new { key = i.K, value = i.V }) }), readAt);

    private static ModelChangeDto Remove(Guid cache, params string[] keys) =>
        new("remove", "cache_items", Guid.NewGuid(), Json(new { cacheId = cache, keys }));

    private static ModelChangeDto UpdateCache(Guid cache, string root, string description, DateTime? readAt = null) =>
        new("update", "caches", cache, Json(new { name = "artists", version = "1.0.0", description, root }), readAt);

    private Task<ModelApplyResultDto> ApplyAsync(params ModelChangeDto[] changes) => _runner.ApplyAsync(changes, _http, Ct);

    private async Task<List<(string Key, string Value)>> StoredAsync()
    {
        _db.ChangeTracker.Clear();
        return (await _db.Set<CacheItem>().Where(i => i.CacheId == _cache).ToListAsync(Ct))
            .OrderBy(i => i.Key, StringComparer.Ordinal).Select(i => (i.Key, i.Value)).ToList();
    }

    private async Task<CacheEntity> RowAsync()
    {
        _db.ChangeTracker.Clear();
        return await _db.Set<CacheEntity>().AsNoTracking().SingleAsync(c => c.Id == _cache, Ct);
    }

    [Fact]
    public async Task AppendAndRemoveApplyInOneTransaction()
    {
        var result = await ApplyAsync(Append(_cache, null, ("a", "A"), ("b", "B")), Remove(_cache, "acme", "ghost"));

        Assert.True(result.Ok);
        Assert.True(result.Applied);
        Assert.Equal([("a", "A"), ("b", "B")], await StoredAsync());
        Assert.Equal(2, (await RowAsync()).ItemCount);
        Assert.Equal(2, result.Results[0].Report!.Value.GetProperty("added").GetInt32());
        Assert.Equal(1, result.Results[1].Report!.Value.GetProperty("removed").GetInt32());
        Assert.Equal(1, result.Results[1].Report!.Value.GetProperty("notFound").GetInt32());
        Assert.Equal(200, result.Results[0].Status);
    }

    [Fact]
    public async Task AppendToCacheCreatedInSameBatchUsesMadeId()
    {
        var client = Guid.NewGuid();
        var create = new ModelChangeDto("create", "caches", client, Json(new { name = "fresh", version = "1.0.0", description = "d", root = $"fresh-{Guid.NewGuid():N}" }));

        var result = await ApplyAsync(create, Append(client, null, ("k", "v")));

        Assert.True(result.Applied);
        var made = result.Made[client];
        var stored = await _db.Set<CacheItem>().AsNoTracking().Where(i => i.CacheId == made).ToListAsync(Ct);
        Assert.Equal(["k"], stored.Select(i => i.Key));
        Assert.Equal(1, (await _db.Set<CacheEntity>().AsNoTracking().SingleAsync(c => c.Id == made, Ct)).ItemCount);
    }

    [Fact]
    public async Task AppendToCacheDeletedEarlierInBatch404sAndNothingApplied()
    {
        var result = await ApplyAsync(
            new ModelChangeDto("delete", "caches", _cache, null),
            Append(_cache, null, ("k", "v")));

        Assert.False(result.Ok);
        Assert.False(result.Applied);
        Assert.True(result.Results[0].Ok);
        Assert.Equal(404, result.Results[1].Status);
        Assert.Equal([("acme", "Acme")], await StoredAsync());
        Assert.Empty(_sender.Sent);
    }

    [Fact]
    public async Task InvalidItemRefusesWholeSave()
    {
        var result = await ApplyAsync(Append(_cache, null, ("good", "G")), Append(_cache, null, ("", "empty key")));

        Assert.False(result.Ok);
        Assert.False(result.Applied);
        Assert.True(result.Results[0].Ok);
        Assert.Equal(400, result.Results[1].Status);
        Assert.Equal([("acme", "Acme")], await StoredAsync());
        Assert.Equal(1, (await RowAsync()).ItemCount);
        Assert.Empty(_sender.Sent);
    }

    [Fact]
    public async Task AnAppendThatPassedIsRolledBackWithItsCountWhenALaterChangeFails()
    {
        var result = await ApplyAsync(Append(_cache, null, ("x", "X"), ("y", "Y")), UpdateCache(Guid.NewGuid(), "r", "nobody"));

        Assert.False(result.Applied);
        Assert.Equal(404, result.Results[1].Status);
        Assert.Equal([("acme", "Acme")], await StoredAsync());
        Assert.Equal(1, (await RowAsync()).ItemCount);
    }

    [Fact]
    public async Task DryRunSendsNoRefreshAndLeavesNoRows()
    {
        var result = await _runner.DryRunAsync([Append(_cache, null, ("a", "A")), Remove(_cache, "acme")], _http, Ct);

        Assert.True(result.Ok);
        Assert.Equal(1, result.Results[0].Report!.Value.GetProperty("added").GetInt32());
        Assert.Equal([("acme", "Acme")], await StoredAsync());
        Assert.Equal(1, (await RowAsync()).ItemCount);
        Assert.Empty(_sender.Sent);
    }

    [Fact]
    public async Task ApplySendsRefreshAfterCommitOnly()
    {
        List<string>? seen = null;
        _sender.OnSend = async () =>
        {
            await using var fresh = fixture.NewContext();
            seen = (await fresh.Set<CacheItem>().Where(i => i.CacheId == _cache).ToListAsync(Ct)).Select(i => i.Key).Order().ToList();
        };

        var result = await ApplyAsync(Append(_cache, null, ("a", "A")), Remove(_cache, "acme"));

        Assert.True(result.Applied);
        Assert.Null(result.Warnings);
        Assert.Equal(["a"], seen); // the committed rows were visible to a separate connection when the message went out
        var sent = Assert.Single(_sender.Sent);
        var body = Assert.IsType<global::Messaging.Contracts.RefreshCacheItems>(sent.Body);
        Assert.Equal(_cache, body.CacheId);
        Assert.Equal(["a", "acme"], body.Keys.Order());
    }

    [Fact]
    public async Task RefreshSendFailureBecomesWarning()
    {
        _sender.Fault = new InvalidOperationException("broker down");

        var result = await ApplyAsync(Append(_cache, null, ("a", "A")));

        Assert.True(result.Ok);
        Assert.True(result.Applied);
        Assert.Equal([("a", "A"), ("acme", "Acme")], await StoredAsync());
        Assert.Equal(["cache artists: running workflows not refreshed (broker down); they catch up at their next start"], result.Warnings);
    }

    [Fact]
    public async Task ItemOpsSkipStaleCheck()
    {
        var old = new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        var result = await ApplyAsync(Append(_cache, old, ("a", "A")));

        Assert.True(result.Applied);
        Assert.Equal(200, result.Results[0].Status);
    }

    [Fact]
    public async Task CacheFieldUpdateStillStaleAfterForeignAppend()
    {
        var read = (await RowAsync()).UpdatedAt;
        await using (var other = fixture.NewContext())
            await new CacheItemsStore(other, TimeProvider.System, new HttpContextAccessor()).AppendAsync(_cache, [new CacheItemDto("z", "Z")], Ct);

        var result = await ApplyAsync(UpdateCache(_cache, _root, "changed", read));

        Assert.False(result.Applied);
        Assert.Equal(409, result.Results[0].Status);
        Assert.Equal("stale", result.Results[0].Problem!.Value.GetProperty("code").GetString());
    }

    [Fact]
    public async Task UpdateThenAppendInOneBatchSucceeds()
    {
        var read = (await RowAsync()).UpdatedAt;

        var result = await ApplyAsync(UpdateCache(_cache, _root, "changed", read), Append(_cache, null, ("a", "A")));

        Assert.True(result.Applied);
        var row = await RowAsync();
        Assert.Equal("changed", row.Description);
        Assert.Equal(2, row.ItemCount);
    }

    [Fact]
    public async Task AppendThenUpdateInOneBatchSucceedsAndIsNotStaleFromItsOwnStamp()
    {
        var read = (await RowAsync()).UpdatedAt;
        await Task.Delay(20, Ct);

        var result = await ApplyAsync(Append(_cache, null, ("a", "A")), UpdateCache(_cache, _root, "changed", read));

        Assert.True(result.Ok, JsonSerializer.Serialize(result.Results));
        Assert.True(result.Applied);
        var row = await RowAsync();
        Assert.Equal("changed", row.Description);
        Assert.Equal(2, row.ItemCount);
        Assert.Equal([("a", "A"), ("acme", "Acme")], await StoredAsync());
    }

    [Fact]
    public async Task AnUpdateAfterAnAppendIsStillStaleWhenAForeignEditCameBeforeTheBatch()
    {
        var read = (await RowAsync()).UpdatedAt;
        await Task.Delay(20, Ct);
        await using (var other = fixture.NewContext())
        {
            var foreign = await other.Set<CacheEntity>().SingleAsync(c => c.Id == _cache, Ct);
            foreign.Description = "foreign";
            await other.SaveChangesAsync(Ct);
        }

        var result = await ApplyAsync(Append(_cache, null, ("a", "A")), UpdateCache(_cache, _root, "mine", read));

        Assert.False(result.Applied);
        Assert.True(result.Results[0].Ok);
        Assert.Equal(409, result.Results[1].Status);
        Assert.Equal("stale", result.Results[1].Problem!.Value.GetProperty("code").GetString());
        var row = await RowAsync();
        Assert.Equal("foreign", row.Description);
        Assert.Equal([("acme", "Acme")], await StoredAsync());
    }

    [Fact]
    public async Task OtherOpsOnCacheItemsAreRefused()
    {
        var result = await ApplyAsync(new ModelChangeDto("update", "cache_items", _cache, Json(new { cacheId = _cache, items = Array.Empty<object>() })));

        Assert.Equal(400, result.Results[0].Status);
        Assert.False(result.Applied);
    }
}
