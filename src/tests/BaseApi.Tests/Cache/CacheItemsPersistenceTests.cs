using BaseApi.Service;
using BaseApi.Service.Features.Cache;
using BaseApi.Tests.Support;
using Messaging.Transport;
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
[Collection("Postgres")]
public sealed class CacheItemsPersistenceTests(PostgresFixture fixture) : IAsyncLifetime
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
        PostgresFixture.SkipUnlessEnabled();
        _db = fixture.NewContext(_clock);
        return ValueTask.CompletedTask;
    }

    public async ValueTask DisposeAsync()
    {
        if (_db is not null) await _db.DisposeAsync();
    }

    private CacheService Service() => CacheServiceFactory.Create(_db, new NoSender());

    // A cache is created empty (its DTO carries no items); the rows are then seeded directly, as the
    // item verbs of a later step write them.
    private async Task<CacheReadDto> CreateAsync(string root, List<CacheItemDto> items)
    {
        var created = await Service().CreateAsync(new CacheCreateDto($"cache-{root}", "1.0.0", null, $"{root}-{Guid.NewGuid():N}"), Ct);
        var row = await _db.Set<CacheEntity>().SingleAsync(c => c.Id == created.Id, Ct);
        _db.Set<CacheItem>().AddRange(items.Select(i => new CacheItem { CacheId = row.Id, Key = i.Key, Value = i.Value }));
        row.ItemCount = items.Count;
        await _db.SaveChangesAsync(Ct);
        return new CacheEntityMapper().ToRead(row);
    }


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
        Assert.Equal(0, created.ItemCount);
    }

    [Fact]
    public async Task AReadReturnsTheStoredItemCount()
    {
        var created = await CreateAsync("artists", [I("gamma", "G"), I("Acme", "A"), I("beta", "B")]);
        _db.ChangeTracker.Clear();

        var read = await Service().GetByIdAsync(created.Id, Ct);

        Assert.Equal(3, read.ItemCount);
    }

    [Fact]
    public async Task AListReadCarriesEachCachesOwnItemCount()
    {
        var a = await CreateAsync("a", [I("x", "1")]);
        var b = await CreateAsync("b", [I("y", "2"), I("z", "3")]);
        _db.ChangeTracker.Clear();

        var list = await Service().ListAsync(Ct);

        Assert.Equal(1, list.Single(c => c.Id == a.Id).ItemCount);
        Assert.Equal(2, list.Single(c => c.Id == b.Id).ItemCount);
    }

    [Fact]
    public async Task AnUpdateRemovesChangesAndAddsInOneSave()
    {
        var created = await CreateAsync("artists", [I("acme", "Acme"), I("beta", "Beta")]);
        _db.ChangeTracker.Clear();

        await Service().UpdateItemsAsync(created.Id, new CacheItemsUpdateDto([I("acme", "Acme (Approved)"), I("gamma", "G")]), Ct);

        Assert.Equal([("acme", "Acme (Approved)"), ("gamma", "G")], await RowsAsync(created.Id));
    }

    [Fact]
    public async Task AnUpdateOnTheSameTrackedContextAsTheCreateSucceeds()
    {
        // No ChangeTracker.Clear between the two: the created rows are still tracked, which is where a
        // replace-the-list mapping fails with "another instance with the same key value is already being tracked".
        var created = await CreateAsync("artists", [I("acme", "Acme")]);

        await Service().UpdateItemsAsync(created.Id, new CacheItemsUpdateDto([I("acme", "Changed")]), Ct);

        Assert.Equal([("acme", "Changed")], await RowsAsync(created.Id));
    }

    [Fact]
    public async Task AnUpdateLeavesOtherCachesItemsAlone()
    {
        var a = await CreateAsync("a", [I("k", "1")]);
        var b = await CreateAsync("b", [I("k", "2")]);
        _db.ChangeTracker.Clear();

        await Service().UpdateItemsAsync(a.Id, new CacheItemsUpdateDto([]), Ct);

        Assert.Empty(await RowsAsync(a.Id));
        Assert.Equal([("k", "2")], await RowsAsync(b.Id));
    }

    [Fact]
    public async Task AnUntrackedQueryOfTheCacheSeesItsItemsOnlyWhenIncluded()
    {
        // How the graph loader and the refresh handler read the row: the items are not auto-included.
        var created = await CreateAsync("artists", [I("acme", "Acme")]);
        _db.ChangeTracker.Clear();

        var bare = await _db.Set<CacheEntity>().AsNoTracking().SingleAsync(c => c.Id == created.Id, Ct);
        Assert.Empty(bare.Items);

        var row = await _db.Set<CacheEntity>().AsNoTracking().Include(c => c.Items).SingleAsync(c => c.Id == created.Id, Ct);

        Assert.Equal([("acme", "Acme")], row.Items.Select(i => (i.Key, i.Value)));
    }

    [Fact]
    public async Task ADictionaryLargerThanTheOldWholeDocumentCapRoundTrips()
    {
        var items = Enumerable.Range(0, 1_500).Select(i => I($"k{i:D4}", new string('v', 1_000))).ToList();

        var created = await CreateAsync("big", items);
        _db.ChangeTracker.Clear();

        var read = await Service().GetByIdAsync(created.Id, Ct);
        Assert.Equal(1_500, read.ItemCount);
        Assert.Equal(items.Select(i => (i.Key, i.Value)), await RowsAsync(created.Id));
    }

    [Fact]
    public async Task AnUpdateAfterModelApplysFreshnessCheckSavesTheItems()
    {
        // /model/apply (Acto's Save) first Finds the row to compare updatedAt, then detaches only the cache row -- its
        // items may stay tracked -- and runs the service's UpdateAsync, then may change the same cache again.
        // (The runner itself needs Postgres savepoints; this drives the same context steps.)
        var created = await CreateAsync("artists", [I("acme", "Acme"), I("beta", "Beta")]);
        _db.ChangeTracker.Clear();

        var found = await _db.FindAsync(typeof(CacheEntity), [created.Id], Ct);
        _db.Entry(found!).State = EntityState.Detached;
        _clock.Advance(TimeSpan.FromMinutes(5));
        var first = await Service().UpdateItemsAsync(created.Id, new CacheItemsUpdateDto([I("acme", "Changed"), I("gamma", "G")]), Ct);
        var second = await Service().UpdateItemsAsync(created.Id, new CacheItemsUpdateDto([I("gamma", "G2")]), Ct);

        Assert.Equal(created.UpdatedAt.AddMinutes(5), first.UpdatedAt);
        Assert.Equal(1, second.ItemCount);
        Assert.Equal([("gamma", "G2")], await RowsAsync(created.Id));
    }

    [Fact]
    public async Task AnItemsOnlyUpdateStampsTheCache()
    {
        // Only child rows change, so EF alone would leave the cache row Unchanged: no UpdatedAt, no
        // xmin bump, and a board holding the old UpdatedAt would overwrite the edit unwarned.
        var created = await CreateAsync("artists", [I("acme", "Acme")]);
        _db.ChangeTracker.Clear();
        _clock.Advance(TimeSpan.FromMinutes(5));

        var updated = await Service().UpdateItemsAsync(created.Id, new CacheItemsUpdateDto([I("acme", "Changed")]), Ct);

        Assert.Equal(created.UpdatedAt.AddMinutes(5), updated.UpdatedAt);
    }

    [Fact]
    public async Task AnUpdateThatChangesNothingDoesNotStampTheCache()
    {
        var created = await CreateAsync("artists", [I("acme", "Acme")]);
        _db.ChangeTracker.Clear();
        _clock.Advance(TimeSpan.FromMinutes(5));

        var updated = await Service().UpdateItemsAsync(created.Id, new CacheItemsUpdateDto([I("acme", "Acme")]), Ct);

        Assert.Equal(created.UpdatedAt, updated.UpdatedAt);
    }
}
