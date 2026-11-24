using BaseApi.Core.Persistence.Interceptors;
using BaseApi.Core.Persistence.Repositories;
using BaseApi.Service;
using BaseApi.Service.Features.Cache;
using Messaging.Transport;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// The cache's CRUD verbs against the child table: one row per item on create, a diff on update (so a
/// key kept across the edit is one row changed, never a delete and an insert of the same key), the
/// rows gone with their cache, every read — tracked or not — seeing the items without naming them, and
/// an items-only edit still stamping the cache row (the board's stale-edit check reads its UpdatedAt).
/// </summary>
public sealed class CacheItemsPersistenceTests : IAsyncLifetime
{
    private readonly FakeTimeProvider _clock = new(new DateTimeOffset(2026, 11, 24, 12, 0, 0, TimeSpan.Zero));
    private AppDbContext _db = null!;

    private sealed class NoSender : IQueueSender
    {
        public Task SendAsync<T>(string queue, string type, T body, CancellationToken ct,
            string? replyTo = null, string? correlationId = null) => Task.CompletedTask;
    }

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static CacheItemDto I(string key, string value) => new(key, value);

    public ValueTask InitializeAsync()
    {
        _db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase($"cache-items-rows-{Guid.NewGuid():N}")
            .AddInterceptors(new AuditInterceptor(new HttpContextAccessor(), _clock))
            .Options);
        return ValueTask.CompletedTask;
    }

    public async ValueTask DisposeAsync() => await _db.DisposeAsync();

    private CacheService Service() => new(
        new CacheCreateDtoValidator(), new CacheUpdateDtoValidator(), new CacheItemsUpdateDtoValidator(),
        new CacheEntityMapper(), new Repository<CacheEntity>(_db), _db, new NoSender());

    private Task<CacheReadDto> CreateAsync(string root, List<CacheItemDto> items) =>
        Service().CreateAsync(new CacheCreateDto($"cache-{root}", "1.0.0", null, root, items), Ct);

    private async Task<List<(string Key, string Value)>> RowsAsync(Guid cacheId)
    {
        _db.ChangeTracker.Clear();
        return (await _db.Set<CacheItem>().Where(i => i.CacheId == cacheId).ToListAsync(Ct))
            .OrderBy(i => i.Key, StringComparer.Ordinal).Select(i => (i.Key, i.Value)).ToList();
    }

    [Fact]
    public async Task CreateStoresOneRowPerItem()
    {
        var created = await CreateAsync("artists", [I("acme", "Acme"), I("beta", "Beta")]);

        Assert.Equal([("acme", "Acme"), ("beta", "Beta")], await RowsAsync(created.Id));
    }

    [Fact]
    public async Task CreateWithNoItemsStoresNoRows()
    {
        var created = await CreateAsync("artists", []);

        Assert.Empty(await RowsAsync(created.Id));
        Assert.Empty(created.Items);
    }

    [Fact]
    public async Task AReadReturnsTheItemsOrderedByKey()
    {
        // The table has no order of its own; ordinal by key is the one order every reader can rely on.
        var created = await CreateAsync("artists", [I("gamma", "G"), I("Acme", "A"), I("beta", "B")]);
        _db.ChangeTracker.Clear();

        var read = await Service().GetByIdAsync(created.Id, Ct);

        Assert.Equal([I("Acme", "A"), I("beta", "B"), I("gamma", "G")], read.Items);
    }

    [Fact]
    public async Task AListReadCarriesEachCachesOwnItems()
    {
        var a = await CreateAsync("a", [I("x", "1")]);
        var b = await CreateAsync("b", [I("y", "2"), I("z", "3")]);
        _db.ChangeTracker.Clear();

        var list = await Service().ListAsync(Ct);

        Assert.Equal([I("x", "1")], list.Single(c => c.Id == a.Id).Items);
        Assert.Equal([I("y", "2"), I("z", "3")], list.Single(c => c.Id == b.Id).Items);
    }

    [Fact]
    public async Task AnUpdateRemovesChangesAndAddsInOneSave()
    {
        var created = await CreateAsync("artists", [I("acme", "Acme"), I("beta", "Beta")]);
        _db.ChangeTracker.Clear();

        await Service().UpdateAsync(created.Id,
            new CacheUpdateDto(created.Name, created.Version, null, created.Root, [I("acme", "Acme (Approved)"), I("gamma", "G")]), Ct);

        Assert.Equal([("acme", "Acme (Approved)"), ("gamma", "G")], await RowsAsync(created.Id));
    }

    [Fact]
    public async Task AnUpdateOnTheSameTrackedContextAsTheCreateSucceeds()
    {
        // No ChangeTracker.Clear between the two: the created rows are still tracked, which is where a
        // replace-the-list mapping fails with "another instance with the same key value is already being tracked".
        var created = await CreateAsync("artists", [I("acme", "Acme")]);

        await Service().UpdateAsync(created.Id,
            new CacheUpdateDto(created.Name, created.Version, null, created.Root, [I("acme", "Changed")]), Ct);

        Assert.Equal([("acme", "Changed")], await RowsAsync(created.Id));
    }

    [Fact]
    public async Task AnUpdateLeavesOtherCachesItemsAlone()
    {
        var a = await CreateAsync("a", [I("k", "1")]);
        var b = await CreateAsync("b", [I("k", "2")]);
        _db.ChangeTracker.Clear();

        await Service().UpdateAsync(a.Id, new CacheUpdateDto(a.Name, a.Version, null, a.Root, []), Ct);

        Assert.Empty(await RowsAsync(a.Id));
        Assert.Equal([("k", "2")], await RowsAsync(b.Id));
    }

    [Fact]
    public async Task DeletingTheCacheDeletesItsItems()
    {
        var created = await CreateAsync("artists", [I("acme", "Acme"), I("beta", "Beta")]);
        _db.ChangeTracker.Clear();

        await Service().DeleteAsync(created.Id, Ct);

        Assert.Empty(await RowsAsync(created.Id));
    }

    [Fact]
    public async Task AnUntrackedQueryOfTheCacheSeesItsItems()
    {
        // How the graph loader and the refresh handler read the row.
        var created = await CreateAsync("artists", [I("acme", "Acme")]);
        _db.ChangeTracker.Clear();

        var row = await _db.Set<CacheEntity>().AsNoTracking().SingleAsync(c => c.Id == created.Id, Ct);

        Assert.Equal([("acme", "Acme")], row.Items.Select(i => (i.Key, i.Value)));
    }

    [Fact]
    public async Task ADictionaryLargerThanTheOldWholeDocumentCapRoundTrips()
    {
        var items = Enumerable.Range(0, 1_500).Select(i => I($"k{i:D4}", new string('v', 1_000))).ToList();

        var created = await CreateAsync("big", items);
        _db.ChangeTracker.Clear();

        var read = await Service().GetByIdAsync(created.Id, Ct);
        Assert.Equal(1_500, read.Items.Count);
        Assert.Equal(items, read.Items);
    }

    [Fact]
    public async Task AnItemsOnlyUpdateStampsTheCache()
    {
        // Only child rows change, so EF alone would leave the cache row Unchanged: no UpdatedAt, no
        // xmin bump, and a board holding the old UpdatedAt would overwrite the edit unwarned.
        var created = await CreateAsync("artists", [I("acme", "Acme")]);
        _db.ChangeTracker.Clear();
        _clock.Advance(TimeSpan.FromMinutes(5));

        var updated = await Service().UpdateAsync(created.Id,
            new CacheUpdateDto(created.Name, created.Version, null, created.Root, [I("acme", "Changed")]), Ct);

        Assert.Equal(created.UpdatedAt.AddMinutes(5), updated.UpdatedAt);
    }

    [Fact]
    public async Task AnUpdateThatChangesNothingDoesNotStampTheCache()
    {
        var created = await CreateAsync("artists", [I("acme", "Acme")]);
        _db.ChangeTracker.Clear();
        _clock.Advance(TimeSpan.FromMinutes(5));

        var updated = await Service().UpdateAsync(created.Id,
            new CacheUpdateDto(created.Name, created.Version, null, created.Root, [I("acme", "Acme")]), Ct);

        Assert.Equal(created.UpdatedAt, updated.UpdatedAt);
    }
}
