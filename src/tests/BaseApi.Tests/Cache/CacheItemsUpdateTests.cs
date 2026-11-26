using BaseApi.Core.Exceptions;
using BaseApi.Service;
using BaseApi.Service.Features.Cache;
using BaseApi.Tests.Support;
using FluentValidation;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// <c>PUT /caches/{id}/items</c>: the item rows replaced, every other field kept, and the refresh sent
/// only once the rows are saved. Postgres: the replace takes the cache row's lock with SQL.
/// </summary>
[Collection("Postgres")]
public sealed class CacheItemsUpdateTests(PostgresFixture fixture) : IAsyncLifetime
{
    private Guid _cache;
    private readonly string _root = $"artists-{Guid.NewGuid():N}";
    private readonly RecordingSender _sender = new();
    private AppDbContext _db = null!;

    private sealed class RecordingSender : IQueueSender
    {
        public List<(string Queue, string Type, object? Body)> Sent { get; } = [];
        public Exception? Fault { get; set; }

        public Task SendAsync<T>(string queue, string type, T body, CancellationToken ct,
            string? replyTo = null, string? correlationId = null)
        {
            if (Fault is not null) throw Fault;
            Sent.Add((queue, type, body));
            return Task.CompletedTask;
        }
    }

    private static CacheItemDto I(string key, string value) => new(key, value);

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
    }

    public async ValueTask DisposeAsync()
    {
        if (_db is not null) await _db.DisposeAsync();
    }

    private CacheService Service() => CacheServiceFactory.Create(_db, _sender);

    private Task<CacheReadDto> UpdateAsync(Guid id, List<CacheItemDto> items) =>
        Service().UpdateItemsAsync(id, new CacheItemsUpdateDto(items), TestContext.Current.CancellationToken);

    private async Task<CacheEntity> RowAsync()
    {
        _db.ChangeTracker.Clear();
        return await _db.Set<CacheEntity>().SingleAsync(c => c.Id == _cache, TestContext.Current.CancellationToken);
    }

    /// <summary>The stored item rows of the cache, read from their own table, ordered by key.</summary>
    private async Task<List<(string Key, string Value)>> StoredAsync()
    {
        _db.ChangeTracker.Clear();
        return (await _db.Set<CacheItem>().Where(i => i.CacheId == _cache).ToListAsync(TestContext.Current.CancellationToken))
            .OrderBy(i => i.Key, StringComparer.Ordinal).Select(i => (i.Key, i.Value)).ToList();
    }

    [Fact]
    public async Task TheItemsAreReplacedInTheRows()
    {
        await UpdateAsync(_cache, [I("beta", "Beta")]);

        Assert.Equal([("beta", "Beta")], await StoredAsync());
    }

    [Fact]
    public async Task AKeptKeyTakesItsNewValueBesideAnAddedKey()
    {
        // The same key in the old and the new set is the case a naive remove-then-add trips on: two
        // tracked rows with one primary key.
        await UpdateAsync(_cache, [I("acme", "Acme (Approved)"), I("beta", "Beta")]);

        Assert.Equal([("acme", "Acme (Approved)"), ("beta", "Beta")], await StoredAsync());
    }

    [Fact]
    public async Task EveryOtherFieldIsKept()
    {
        await UpdateAsync(_cache, [I("beta", "Beta")]);

        var row = await RowAsync();
        Assert.Equal(("artists", "1.0.0", "the whitelist", _root), (row.Name, row.Version, row.Description, row.Root));
    }

    [Fact]
    public async Task TheBoardLocationIsKept()
    {
        _db.ChangeTracker.Clear();
        var placed = await _db.Set<CacheEntity>().SingleAsync(c => c.Id == _cache, TestContext.Current.CancellationToken);
        placed.BoardX = 300;
        placed.BoardY = 10;
        await _db.SaveChangesAsync(TestContext.Current.CancellationToken);

        await UpdateAsync(_cache, [I("beta", "Beta")]);

        var row = await RowAsync();
        Assert.Equal((300.0, 10.0), (row.BoardX, row.BoardY));
    }

    [Fact]
    public async Task TheReadDtoCarriesTheNewItemCount()
    {
        var read = await UpdateAsync(_cache, [I("gamma", "G"), I("beta", "Beta")]);

        Assert.Equal(2, read.ItemCount);
    }

    [Fact]
    public async Task OneRefreshIsSentOnTheControlQueue()
    {
        await UpdateAsync(_cache, [I("beta", "Beta")]);

        var sent = Assert.Single(_sender.Sent);
        Assert.Equal(OrchestratorQueues.Control, sent.Queue);
        Assert.Equal(MessageTypes.RefreshCache, sent.Type);
        Assert.Equal(new RefreshCache(_cache), sent.Body);
    }

    [Fact]
    public async Task EmptyItemsAreAllowedAndLeaveNoRows()
    {
        // "Allow nothing" is a whitelist too.
        await UpdateAsync(_cache, []);

        Assert.Empty(await StoredAsync());
    }

    [Fact]
    public async Task AnUnknownCacheIsNotFoundAndSendsNothing()
    {
        await Assert.ThrowsAsync<NotFoundException>(() => UpdateAsync(Guid.NewGuid(), [I("beta", "Beta")]));

        Assert.Empty(_sender.Sent);
    }

    [Fact]
    public async Task AKeyWithAColonIsRefusedAndSendsNothing()
    {
        await Assert.ThrowsAsync<ValidationException>(() => UpdateAsync(_cache, [I("a:b", "x")]));

        Assert.Equal([("acme", "Acme")], await StoredAsync());
        Assert.Empty(_sender.Sent);
    }

    [Fact]
    public async Task AKeyTwiceIsRefusedAndSendsNothing()
    {
        await Assert.ThrowsAsync<ValidationException>(() => UpdateAsync(_cache, [I("beta", "1"), I("beta", "2")]));

        Assert.Equal([("acme", "Acme")], await StoredAsync());
        Assert.Empty(_sender.Sent);
    }

    [Fact]
    public async Task NoItemsAtAllIsRefused()
    {
        await Assert.ThrowsAsync<ValidationException>(() =>
            Service().UpdateItemsAsync(_cache, new CacheItemsUpdateDto(null!), TestContext.Current.CancellationToken));

        Assert.Empty(_sender.Sent);
    }

    [Fact]
    public async Task ASendFaultIsTaggedAfterTheRowsAreSaved()
    {
        _sender.Fault = new InvalidOperationException("broker down");

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => UpdateAsync(_cache, [I("beta", "Beta")]));

        Assert.Equal("SendRefreshCache", ex.Data["brokerOp"]);
        Assert.Equal([("beta", "Beta")], await StoredAsync());
    }

    [Fact]
    public async Task AReplaceRacingAnAppendLeavesItemCountEqualToTheRealRowCount()
    {
        var ct = TestContext.Current.CancellationToken;

        // The append holds the cache row's lock (its transaction is open) while the replace starts.
        await using var appendDb = fixture.NewContext();
        await using var tx = await appendDb.Database.BeginTransactionAsync(ct);
        await new CacheItemsStore(appendDb, TimeProvider.System, new Microsoft.AspNetCore.Http.HttpContextAccessor())
            .AppendAsync(_cache, [I("late", "L"), I("later", "LL")], ct);

        await using var replaceDb = fixture.NewContext();
        var replace = CacheServiceFactory.Create(replaceDb, _sender)
            .UpdateItemsAsync(_cache, new CacheItemsUpdateDto([I("beta", "Beta"), I("gamma", "G"), I("delta", "D")]), ct);

        await Task.Delay(500, ct);
        Assert.False(replace.IsCompleted, "the replace must wait for the append's lock on the cache row");
        await tx.CommitAsync(ct);
        await replace;

        var stored = await StoredAsync();
        var row = await RowAsync();
        Assert.Equal(stored.Count, row.ItemCount);
        Assert.Equal([("beta", "Beta"), ("delta", "D"), ("gamma", "G")], stored);
    }
}
