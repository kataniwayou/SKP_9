using BaseApi.Service.Features.Cache;
using BaseApi.Tests.Support;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// Deleting a cache removes its item rows. Since the items are no longer auto-included, the delete does not
/// load them, so the database's foreign-key cascade does the work: this needs a real Postgres (the in-memory
/// provider only cascades tracked rows).
/// </summary>
[Collection("Postgres")]
public sealed class CacheItemsCascadeTests(PostgresFixture fixture)
{
    [Fact]
    public async Task DeletingTheCacheDeletesItsItems()
    {
        PostgresFixture.SkipUnlessEnabled();
        var ct = TestContext.Current.CancellationToken;

        await using var db = fixture.NewContext();
        var cache = new CacheEntity { Name = "c", Version = "1.0.0", Root = $"r-{Guid.NewGuid():N}", ItemCount = 2 };
        db.Set<CacheEntity>().Add(cache);
        await db.SaveChangesAsync(ct);
        db.Set<CacheItem>().AddRange(
            new CacheItem { CacheId = cache.Id, Key = "a", Value = "1" },
            new CacheItem { CacheId = cache.Id, Key = "b", Value = "2" });
        await db.SaveChangesAsync(ct);
        db.ChangeTracker.Clear();

        var bare = await db.Set<CacheEntity>().SingleAsync(c => c.Id == cache.Id, ct);
        db.Remove(bare);
        await db.SaveChangesAsync(ct);

        Assert.Empty(await db.Set<CacheItem>().Where(i => i.CacheId == cache.Id).ToListAsync(ct));
    }
}
