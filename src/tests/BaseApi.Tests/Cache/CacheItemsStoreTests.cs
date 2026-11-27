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

    private static List<CacheItemDto> Many(int from, int count, string value = "v") =>
        Enumerable.Range(from, count).Select(n => new CacheItemDto($"k{n:D6}", value)).ToList();

    [Fact]
    public void SlicesSplitABatchIntoAtMost5000Rows()
    {
        Assert.Equal(5_000, CacheItemsStore.SliceSize);
        var sizes = CacheItemsStore.Slices(Many(0, 12_345), CacheItemsStore.SliceSize).Select(s => s.Count).ToArray();
        Assert.Equal([5_000, 5_000, 2_345], sizes);
        Assert.Empty(CacheItemsStore.Slices(new List<string>(), CacheItemsStore.SliceSize));
    }

    [Fact]
    public void CutByBudgetCountsRowsWhileTheTotalStaysWithinAndAlwaysTheFirst()
    {
        Assert.Equal(8_000_000, CacheRules.PageCharBudget);
        Assert.Equal(7, CacheItemsStore.CutByBudget(Enumerable.Repeat(1_048_579L, 40).ToList(), CacheRules.PageCharBudget));
        Assert.Equal(2, CacheItemsStore.CutByBudget([4, 6, 1], 10));
        Assert.Equal(1, CacheItemsStore.CutByBudget([11, 1], 10));
        Assert.Equal(3, CacheItemsStore.CutByBudget([1, 1, 1], 10));
        Assert.Equal(0, CacheItemsStore.CutByBudget([], 10));
    }

    [Fact]
    public async Task AppendAcrossSliceBoundariesReportsAddedThenOverwritten()
    {
        var id = await NewCacheAsync();
        await using var db = fixture.NewContext();
        var r = await Store(db).AppendAsync(id, Many(0, 12_345), Ct);
        Assert.Equal(12_345, r.Added);
        Assert.Equal(0, r.Overwritten);
        Assert.Equal(12_345, (await CacheAsync(id)).ItemCount);

        var again = await Store(db).AppendAsync(id, Many(0, 12_345, "w"), Ct);
        Assert.Equal(0, again.Added);
        Assert.Equal(12_345, again.Overwritten);
        Assert.True(again.KeysTruncated);
        Assert.Equal(CacheRules.ReportKeyCap, again.OverwrittenKeys.Count);
        Assert.Equal(12_345, (await CacheAsync(id)).ItemCount);
        var stored = await StoredAsync(id);
        Assert.Equal(12_345, stored.Count);
        Assert.All(stored.Values, v => Assert.Equal("w", v));
    }

    [Fact]
    public async Task MixedAppendAcrossSlicesSplitsAddedAndOverwritten()
    {
        var id = await NewCacheAsync();
        await using var db = fixture.NewContext();
        await Store(db).AppendAsync(id, Many(0, 6_000), Ct);   // k000000..k005999

        // 4,000 stored keys spread over both ends, 8,345 new ones, in one batch of 12,345.
        var batch = Many(5_000, 1_000, "x").Concat(Many(0, 3_000, "x")).Concat(Many(6_000, 8_345, "x")).ToList();
        var r = await Store(db).AppendAsync(id, batch, Ct);

        Assert.Equal(8_345, r.Added);
        Assert.Equal(4_000, r.Overwritten);
        Assert.Equal(6_000 + 8_345, (await CacheAsync(id)).ItemCount);
        Assert.Equal(14_345, (await StoredAsync(id)).Count);
    }

    [Fact]
    public async Task RemoveAcrossSliceBoundariesCountsRemovedAndNotFound()
    {
        var id = await NewCacheAsync();
        await using var db = fixture.NewContext();
        await Store(db).AppendAsync(id, Many(0, 10_000), Ct);

        // 12,345 keys: 10,000 stored plus 2,345 never stored, interleaved so every slice has both.
        var keys = Many(0, 12_345).Select(i => i.Key).OrderBy(k => k.GetHashCode()).ToList();
        var r = await Store(db).RemoveAsync(id, keys, Ct);

        Assert.Equal(10_000, r.Removed);
        Assert.Equal(2_345, r.NotFound);
        Assert.Equal(0, (await CacheAsync(id)).ItemCount);
        Assert.Empty(await StoredAsync(id));
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

    /// <summary>
    /// 40 values at the 1 MiB maximum, limit 500: a row is 3 + 1,048,576 = 1,048,579 characters, so 7 rows are
    /// 7,340,053 (within 8,000,000) and 8 would be 8,388,632 (past it). The first page holds 7 with next set, and
    /// the walk returns all 40 once.
    /// </summary>
    [Fact]
    public async Task APageOfMaximumValuesStopsAtTheCharacterBudget()
    {
        var id = await NewCacheAsync();
        var big = new string('v', 1_048_576);
        await using (var seed = fixture.NewContext())
        {
            for (var at = 0; at < 40; at += 5)
            {
                await Store(seed).AppendAsync(id, Enumerable.Range(at, 5).Select(i => new CacheItemDto($"k{i:D2}", big)).ToList(), Ct);
            }
        }

        const long row = 3 + 1_048_576;
        Assert.True(7 * row <= CacheRules.PageCharBudget && 8 * row > CacheRules.PageCharBudget);

        await using var db = fixture.NewContext();
        var first = await Store(db).PageAsync(id, null, 500, Ct);
        Assert.Equal(7, first.Items.Count);
        Assert.Equal("k06", first.Next);
        Assert.All(first.Items, i => Assert.Equal(1_048_576, i.Value.Length));

        var seen = new List<string>();
        var sizes = new List<int>();
        string? after = null;
        do
        {
            var page = await Store(db).PageAsync(id, after, 500, Ct);
            sizes.Add(page.Items.Count);
            seen.AddRange(page.Items.Select(i => i.Key));
            after = page.Next;
        } while (after is not null);

        Assert.Equal([7, 7, 7, 7, 7, 5], sizes);
        Assert.Equal(Enumerable.Range(0, 40).Select(i => $"k{i:D2}"), seen);
    }

    [Fact]
    public async Task ARowAloneOverTheBudgetIsStillReturnedByItself()
    {
        var id = await NewCacheAsync();
        await using var db = fixture.NewContext();
        await Store(db).AppendAsync(id, Items(("a", new string('x', 100)), ("b", new string('y', 100)), ("c", "1")), Ct);

        var p1 = await Store(db).PageAsync(id, null, 500, Ct, charBudget: 50);
        Assert.Equal(["a"], p1.Items.Select(i => i.Key));
        Assert.Equal(100, p1.Items[0].Value.Length);
        Assert.Equal("a", p1.Next);

        var p2 = await Store(db).PageAsync(id, p1.Next, 500, Ct, charBudget: 50);
        Assert.Equal(["b"], p2.Items.Select(i => i.Key));
        Assert.Equal("b", p2.Next);

        var p3 = await Store(db).PageAsync(id, p2.Next, 500, Ct, charBudget: 50);
        Assert.Equal(["c"], p3.Items.Select(i => i.Key));
        Assert.Null(p3.Next);
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

    private async Task<Guid> SeedKeysAsync(params string[] keys)
    {
        var id = await NewCacheAsync();
        await using var db = fixture.NewContext();
        await Store(db).AppendAsync(id, keys.Select(k => new CacheItemDto(k, "v")).ToList(), Ct);
        return id;
    }

    private async Task<CacheItemsPage> ReadAsync(Guid id, CachePageMode mode, string? key, int limit, long? budget = null)
    {
        await using var db = fixture.NewContext();
        return budget is null
            ? await Store(db).PageAsync(id, new CachePageAt(mode, key), limit, Ct)
            : await Store(db).PageAsync(id, new CachePageAt(mode, key), limit, Ct, budget.Value);
    }

    private static string[] AtoJ => "abcdefghij".Select(c => c.ToString()).ToArray();

    [Fact]
    public async Task FromReturnsTheKeyItselfAsExact()
    {
        var id = await SeedKeysAsync(AtoJ);
        var p = await ReadAsync(id, CachePageMode.From, "d", 3);
        Assert.Equal(["d", "e", "f"], p.Items.Select(i => i.Key));
        Assert.Equal(3, p.Index);
        Assert.Equal("exact", p.FromMatch);
        Assert.Equal("d", p.Prev);
        Assert.Equal("f", p.Next);
    }

    [Fact]
    public async Task FromBetweenKeysStartsAtTheNextKey()
    {
        var id = await SeedKeysAsync("a", "c", "e");
        var p = await ReadAsync(id, CachePageMode.From, "b", 3);
        Assert.Equal("c", p.Items[0].Key);
        Assert.Equal("later", p.FromMatch);
        Assert.Equal(1, p.Index);
    }

    [Fact]
    public async Task FromPastTheEndReturnsTheLastPage()
    {
        var id = await SeedKeysAsync(AtoJ);
        var p = await ReadAsync(id, CachePageMode.From, "z", 3);
        Assert.Equal(["h", "i", "j"], p.Items.Select(i => i.Key));
        Assert.Equal("none", p.FromMatch);
        Assert.Equal(7, p.Index);
        Assert.Null(p.Next);
    }

    [Fact]
    public async Task BeforeReturnsThePreviousRowsAscending()
    {
        var id = await SeedKeysAsync(AtoJ);
        var p = await ReadAsync(id, CachePageMode.Before, "g", 3);
        Assert.Equal(["d", "e", "f"], p.Items.Select(i => i.Key));
        Assert.Equal(3, p.Index);
        Assert.Equal("d", p.Prev);
        Assert.Equal("f", p.Next);
        Assert.Null(p.FromMatch);
    }

    [Fact]
    public async Task BeforeNearTheStartReturnsFewerRows()
    {
        var id = await SeedKeysAsync(AtoJ);
        var p = await ReadAsync(id, CachePageMode.Before, "b", 3);
        Assert.Equal(["a"], p.Items.Select(i => i.Key));
        Assert.Equal(0, p.Index);
        Assert.Null(p.Prev);
    }

    [Fact]
    public async Task BeforeAKeyThatNoLongerExistsReturnsTheRowsBeforeIt()
    {
        var id = await SeedKeysAsync("a", "b", "d");
        var p = await ReadAsync(id, CachePageMode.Before, "c", 5);
        Assert.Equal(["a", "b"], p.Items.Select(i => i.Key));
    }

    [Fact]
    public async Task FromIsCaseAndCollationAware()
    {
        var id = await SeedKeysAsync("SKP Big Artist 0500000", "skp live suite");
        await using var db = fixture.NewContext();
        var dbOrder = await db.Database.SqlQuery<string>($"SELECT key AS \"Value\" FROM cache_items WHERE cache_id = {id} ORDER BY key").ToListAsync(Ct);
        var p = await ReadAsync(id, CachePageMode.From, "SKP Live Suite", 5);
        Assert.Equal("skp live suite", p.Items[0].Key);
        Assert.Equal("later", p.FromMatch);
        Assert.Equal(dbOrder.Skip((int)p.Index).ToList(), p.Items.Select(i => i.Key).ToList());
    }

    [Fact]
    public async Task IndexCountsKeysBeforeTheFirstRow()
    {
        var id = await SeedKeysAsync(Enumerable.Range(0, 1200).Select(i => $"key{i:D5}").ToArray());
        var p = await ReadAsync(id, CachePageMode.After, "key00499", 100);
        Assert.Equal("key00500", p.Items[0].Key);
        Assert.Equal(500, p.Index);
    }

    [Fact]
    public async Task TheCharacterBudgetCutsBeforePagesFromTheFarEnd()
    {
        var id = await SeedKeysAsync("a", "b", "c", "z");
        // each row is key(1) + value(1) = 2 chars; a budget of 4 fits 2 of 3
        var p = await ReadAsync(id, CachePageMode.Before, "z", 3, budget: 4);
        Assert.Equal(["b", "c"], p.Items.Select(i => i.Key));
        Assert.Equal(1, p.Index);
        Assert.Equal("c", p.Next);
    }
}
