using BaseApi.Core.Exceptions;
using BaseApi.Core.Persistence.Repositories;
using BaseApi.Service;
using BaseApi.Service.Features.Cache;
using FluentValidation;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// <c>PUT /caches/{id}/items</c>: the item rows replaced, every other field kept, and the refresh sent
/// only once the rows are saved.
/// </summary>
public sealed class CacheItemsUpdateTests : IAsyncLifetime
{
    private readonly Guid _cache = Guid.NewGuid();
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
        _db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase($"cache-items-{Guid.NewGuid():N}")
            .Options);

        _db.Set<CacheEntity>().Add(new CacheEntity
        {
            Id = _cache, Name = "artists", Version = "1.0.0", Description = "the whitelist", Root = "artists",
            Items = [new CacheItem { Key = "acme", Value = "Acme" }],
        });
        await _db.SaveChangesAsync(TestContext.Current.CancellationToken);
        _db.ChangeTracker.Clear();
    }

    public async ValueTask DisposeAsync() => await _db.DisposeAsync();

    private CacheService Service() => new(
        new CacheCreateDtoValidator(), new CacheUpdateDtoValidator(), new CacheItemsUpdateDtoValidator(),
        new CacheEntityMapper(), new Repository<CacheEntity>(_db), _db, _sender);

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
        Assert.Equal(("artists", "1.0.0", "the whitelist", "artists"), (row.Name, row.Version, row.Description, row.Root));
    }

    [Fact]
    public async Task TheReadDtoCarriesTheNewItemsOrderedByKey()
    {
        var read = await UpdateAsync(_cache, [I("gamma", "G"), I("beta", "Beta")]);

        Assert.Equal([I("beta", "Beta"), I("gamma", "G")], read.Items);
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
}
