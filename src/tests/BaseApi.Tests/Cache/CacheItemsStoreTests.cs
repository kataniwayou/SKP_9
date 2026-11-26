using BaseApi.Core.Exceptions;
using BaseApi.Service;
using BaseApi.Service.Features.Cache;
using BaseApi.Tests.Support;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>The set-based cache item SQL (<c>unnest</c>, <c>ON CONFLICT</c>, keyset paging): needs a real Postgres.</summary>
[Collection("Postgres")]
public sealed class CacheItemsStoreTests(PostgresFixture fixture)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static CacheItemsStore Store(AppDbContext db) => new(db, TimeProvider.System, new HttpContextAccessor());

    private async Task<Guid> NewCacheAsync()
    {
        PostgresFixture.SkipUnlessEnabled();
        await using var db = fixture.NewContext();
        var cache = new CacheEntity { Name = "c", Version = "1.0.0", Root = $"r-{Guid.NewGuid():N}" };
        db.Set<CacheEntity>().Add(cache);
        await db.SaveChangesAsync(Ct);
        return cache.Id;
    }

    private static List<CacheItemDto> Items(params (string k, string v)[] kv) => kv.Select(x => new CacheItemDto(x.k, x.v)).ToList();

    private async Task<Dictionary<string, string>> StoredAsync(Guid id)
    {
        await using var db = fixture.NewContext();
        return await db.Set<CacheItem>().Where(i => i.CacheId == id).ToDictionaryAsync(i => i.Key, i => i.Value, Ct);
    }

    private async Task<CacheEntity> CacheAsync(Guid id)
    {
        await using var db = fixture.NewContext();
        return await db.Set<CacheEntity>().AsNoTracking().SingleAsync(c => c.Id == id, Ct);
    }

    [Fact]
    public async Task AppendAddsRowsAndReportsAdded()
    {
        var id = await NewCacheAsync();
        await using var db = fixture.NewContext();
        var r = await Store(db).AppendAsync(id, Items(("a", "1"), ("b", "2")), Ct);

        Assert.Equal(2, r.Added);
        Assert.Equal(0, r.Overwritten);
        Assert.Equal(0, r.RepeatedInBatch);
        Assert.False(r.KeysTruncated);
        Assert.Equal(new Dictionary<string, string> { ["a"] = "1", ["b"] = "2" }, await StoredAsync(id));
    }

    [Fact]
    public async Task AppendOverwritesExistingAndReportsOverwritten()
    {
        var id = await NewCacheAsync();
        await using var db = fixture.NewContext();
        await Store(db).AppendAsync(id, Items(("a", "1"), ("b", "2")), Ct);
        var r = await Store(db).AppendAsync(id, Items(("b", "9"), ("c", "3")), Ct);

        Assert.Equal(1, r.Added);
        Assert.Equal(1, r.Overwritten);
        Assert.Equal(["b"], r.OverwrittenKeys);
        Assert.Equal("9", (await StoredAsync(id))["b"]);
    }

    [Fact]
    public async Task AppendRepeatsLastWinsAndReported()
    {
        var id = await NewCacheAsync();
        await using var db = fixture.NewContext();
        var r = await Store(db).AppendAsync(id, Items(("a", "1"), ("a", "2")), Ct);

        Assert.Equal(1, r.Added);
        Assert.Equal(1, r.RepeatedInBatch);
        Assert.Equal(["a"], r.RepeatedKeys);
        Assert.Equal("2", (await StoredAsync(id))["a"]);
    }

    [Fact]
    public async Task AppendUnchangedValueNotRewritten()
    {
        var id = await NewCacheAsync();
        await using var db = fixture.NewContext();
        await Store(db).AppendAsync(id, Items(("a", "1"), ("b", "2")), Ct);
        var before = await XminsAsync(id);

        await Store(db).AppendAsync(id, Items(("a", "1"), ("b", "changed")), Ct);
        var after = await XminsAsync(id);

        Assert.Equal(before["a"], after["a"]);
        Assert.NotEqual(before["b"], after["b"]);
    }

    private async Task<Dictionary<string, string>> XminsAsync(Guid id)
    {
        await using var db = fixture.NewContext();
        return await db.Database.SqlQueryRaw<XminRow>(
            "SELECT key AS \"Key\", xmin::text AS \"Xmin\" FROM cache_items WHERE cache_id = {0}", id)
            .ToDictionaryAsync(x => x.Key, x => x.Xmin, Ct);
    }

    private sealed record XminRow(string Key, string Xmin);

    private static IHttpContextAccessor SignedIn(string name) => new HttpContextAccessor
    {
        HttpContext = new DefaultHttpContext
        {
            User = new System.Security.Claims.ClaimsPrincipal(new System.Security.Claims.ClaimsIdentity(
                [new System.Security.Claims.Claim(System.Security.Claims.ClaimTypes.Name, name)], "test",
                System.Security.Claims.ClaimTypes.Name, System.Security.Claims.ClaimTypes.Role))
        }
    };

    [Fact]
    public async Task AppendAndRemoveStampCacheUpdatedAtUpdatedByAndItemCount()
    {
        var id = await NewCacheAsync();
        // A day after the insert's own UpdatedAt, so only the store's stamp can produce it.
        var instant = new DateTimeOffset(DateTime.UtcNow.AddDays(1).Ticks / 10 * 10, TimeSpan.Zero);
        var clock = new Microsoft.Extensions.Time.Testing.FakeTimeProvider(instant);
        await using var db = fixture.NewContext();
        await new CacheItemsStore(db, clock, SignedIn("alice")).AppendAsync(id, Items(("a", "1"), ("b", "2")), Ct);

        var cache = await CacheAsync(id);
        Assert.Equal(2, cache.ItemCount);
        Assert.Equal(instant.UtcDateTime, cache.UpdatedAt);
        Assert.Equal("alice", cache.UpdatedBy);

        var later = instant.AddHours(1);
        clock.SetUtcNow(later);
        await new CacheItemsStore(db, clock, SignedIn("bob")).RemoveAsync(id, ["a"], Ct);

        cache = await CacheAsync(id);
        Assert.Equal(1, cache.ItemCount);
        Assert.Equal(later.UtcDateTime, cache.UpdatedAt);
        Assert.Equal("bob", cache.UpdatedBy);
    }

    [Fact]
    public async Task AppendToMissingCacheThrowsNotFound()
    {
        PostgresFixture.SkipUnlessEnabled();
        await using var db = fixture.NewContext();
        await Assert.ThrowsAsync<NotFoundException>(() => Store(db).AppendAsync(Guid.NewGuid(), Items(("a", "1")), Ct));
        await Assert.ThrowsAsync<NotFoundException>(() => Store(db).RemoveAsync(Guid.NewGuid(), ["a"], Ct));
        await Assert.ThrowsAsync<NotFoundException>(() => Store(db).PageAsync(Guid.NewGuid(), null, 10, Ct));
    }

    [Fact]
    public async Task ReportKeyListsCapAt1000()
    {
        var id = await NewCacheAsync();
        var batch = Enumerable.Range(0, 1500).Select(i => new CacheItemDto($"k{i}", "1")).ToList();
        await using var db = fixture.NewContext();
        await Store(db).AppendAsync(id, batch, Ct);
        var r = await Store(db).AppendAsync(id, batch.Select(i => i with { Value = "2" }).ToList(), Ct);

        Assert.Equal(1500, r.Overwritten);
        Assert.Equal(1000, r.OverwrittenKeys.Count);
        Assert.True(r.KeysTruncated);
    }

    [Fact]
    public async Task RemoveDeletesAndReportsNotFound()
    {
        var id = await NewCacheAsync();
        await using var db = fixture.NewContext();
        await Store(db).AppendAsync(id, Items(("a", "1"), ("b", "2"), ("c", "3")), Ct);
        var r = await Store(db).RemoveAsync(id, ["a", "c", "zz"], Ct);

        Assert.Equal(2, r.Removed);
        Assert.Equal(1, r.NotFound);
        Assert.Equal(["zz"], r.NotFoundKeys);
        Assert.Equal(["b"], (await StoredAsync(id)).Keys);
        Assert.Equal(1, (await CacheAsync(id)).ItemCount);
    }

    [Fact]
    public async Task RemoveRepeatsCollapsedAndReported()
    {
        var id = await NewCacheAsync();
        await using var db = fixture.NewContext();
        await Store(db).AppendAsync(id, Items(("a", "1"), ("b", "2")), Ct);
        var r = await Store(db).RemoveAsync(id, ["a", "a", "a"], Ct);

        Assert.Equal(1, r.Removed);
        Assert.Equal(2, r.RepeatedInBatch);
        Assert.Equal(["a"], r.RepeatedKeys);
    }

    [Fact]
    public async Task ParallelAppendsToOneCacheAllSucceed()
    {
        var id = await NewCacheAsync();
        var tasks = Enumerable.Range(0, 8).Select(async n =>
        {
            await using var db = fixture.NewContext();
            // Overlapping ranges: worker n writes keys n*50 .. n*50+99.
            var batch = Enumerable.Range(n * 50, 100).Select(i => new CacheItemDto($"k{i}", $"v{n}")).ToList();
            await Store(db).AppendAsync(id, batch, Ct);
        }).ToArray();
        await Task.WhenAll(tasks);

        var expected = 7 * 50 + 100;
        Assert.Equal(expected, (await StoredAsync(id)).Count);
        Assert.Equal(expected, (await CacheAsync(id)).ItemCount);
    }

    [Fact]
    public async Task PageWalksAllKeysOnce()
    {
        var id = await NewCacheAsync();
        await using var db = fixture.NewContext();
        await Store(db).AppendAsync(id, Enumerable.Range(0, 2345).Select(i => new CacheItemDto($"key{i:D5}", "v")).ToList(), Ct);

        var seen = new List<string>();
        string? after = null;
        var pages = 0;
        do
        {
            var page = await Store(db).PageAsync(id, after, 500, Ct);
            pages++;
            seen.AddRange(page.Items.Select(i => i.Key));
            after = page.Next;
        } while (after is not null);

        Assert.Equal(5, pages);
        Assert.Equal(2345, seen.Count);
        Assert.Equal(2345, seen.Distinct().Count());
    }

    [Fact]
    public async Task PageWalksMixedCaseAndPunctuationKeysOnce()
    {
        var id = await NewCacheAsync();
        string[] keys = ["a", "A", "a ", "a-b", "a_b", "ä", "Z", "z"];
        await using var db = fixture.NewContext();
        await Store(db).AppendAsync(id, keys.Select(k => new CacheItemDto(k, "v")).ToList(), Ct);

        var seen = new List<string>();
        string? after = null;
        do
        {
            var page = await Store(db).PageAsync(id, after, 3, Ct);
            seen.AddRange(page.Items.Select(i => i.Key));
            after = page.Next;
        } while (after is not null);

        Assert.Equal(keys.Length, seen.Count);
        Assert.Equal(keys.ToHashSet(), seen.ToHashSet());
    }

    [Fact]
    public async Task ReadKeysReturnsNullForAbsent()
    {
        var id = await NewCacheAsync();
        await using var db = fixture.NewContext();
        await Store(db).AppendAsync(id, Items(("a", "1")), Ct);
        var r = await Store(db).ReadKeysAsync(id, ["a", "nope"], Ct);

        Assert.Equal("1", r["a"]);
        Assert.Null(r["nope"]);
        Assert.Equal(new Dictionary<string, string> { ["a"] = "1" }, await Store(db).ReadAllAsync(id, Ct));
    }

    [Fact]
    public async Task AppendInsideOuterTransactionRollsBackWithIt()
    {
        var id = await NewCacheAsync();
        await using var db = fixture.NewContext();
        await using (var tx = await db.Database.BeginTransactionAsync(Ct))
        {
            await Store(db).AppendAsync(id, Items(("a", "1")), Ct);
            Assert.Single(await Store(db).ReadAllAsync(id, Ct)); // visible inside
            await tx.RollbackAsync(Ct);
        }

        Assert.Empty(await StoredAsync(id));
        Assert.Equal(0, (await CacheAsync(id)).ItemCount);
    }

    [Fact]
    public void LastWinsAndDistinctCollapseRepeats()
    {
        var (items, repeated) = CacheItemsStore.LastWins(Items(("a", "1"), ("b", "x"), ("a", "2"), ("a", "3")));
        Assert.Equal(2, items.Count);
        Assert.Equal("3", items.Single(i => i.Key == "a").Value);
        Assert.Equal(["a"], repeated);
        var (keys, rep2) = CacheItemsStore.Distinct(["x", "y", "x"]);
        Assert.Equal(["x", "y"], keys);
        Assert.Equal(["x"], rep2);
    }
}
