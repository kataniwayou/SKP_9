using System.Diagnostics;
using BaseApi.Service;
using BaseApi.Service.Features.Cache;
using BaseApi.Tests.Support;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.Scale;

/// <summary>
/// Spec 7.1 (S1, S3-S7, S9, S10) through <see cref="CacheService"/> on a real Postgres, one fresh context
/// per call as a request has. On demand only: <c>SKP_SCALE=1</c> and <c>SKP_TEST_PG</c>. S1 and S10 share one
/// load of the 1,000,000-item reference cache (20 x 50,000, 500-char values) that S4 and S7 then reuse.
/// </summary>
[Collection("Postgres")]
[Trait("Category", ScaleGate.Category)]
public sealed class CacheItemsScaleTests(PostgresFixture fixture)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private sealed record Load(Guid CacheId, long[] BatchMs, long[] HeapAfter, int ItemCount, long PayloadBytes);

    // One load for the class: S1 and S10 assert on it, S4 and S7 use its cache. A static so it survives
    // xunit's instance-per-test; the collection runs the tests one at a time.
    private static Task<Load>? _load;

    private async Task<Guid> NewCacheAsync(string tag)
    {
        await using var db = fixture.NewContext();
        var cache = new CacheEntity { Name = $"scale-{tag}", Version = "1.0.0", Root = $"scale-{tag}-{Guid.NewGuid():N}" };
        db.Set<CacheEntity>().Add(cache);
        await db.SaveChangesAsync(Ct);
        return cache.Id;
    }

    private async Task<CacheAppendReport> AppendAsync(Guid id, List<CacheItemDto> items)
    {
        await using var db = fixture.NewContext();
        return await CacheServiceFactory.Create(db, new NullSender()).AppendItemsAsync(id, new CacheItemsAppendDto(items), Ct);
    }

    private async Task<int> ItemCountAsync(Guid id)
    {
        await using var db = fixture.NewContext();
        return (await db.Set<CacheEntity>().AsNoTracking().SingleAsync(c => c.Id == id, Ct)).ItemCount;
    }

    private async Task<long> RowCountAsync(Guid id)
    {
        await using var db = fixture.NewContext();
        return await db.Database.SqlQuery<long>($"SELECT count(*) AS \"Value\" FROM cache_items WHERE cache_id = {id}").SingleAsync(Ct);
    }

    private Task<Load> LoadReferenceAsync() => _load ??= LoadCoreAsync();

    private async Task<Load> LoadCoreAsync()
    {
        var id = await NewCacheAsync("ref");
        var ms = new long[ScaleData.Batches];
        var heap = new long[ScaleData.Batches];
        for (var b = 0; b < ScaleData.Batches; b++)
        {
            var sw = Stopwatch.StartNew();
            var items = ScaleData.Items(b * ScaleData.BatchSize, ScaleData.BatchSize);
            var gen = sw.ElapsedMilliseconds;
            sw.Restart();
            var report = await AppendAsync(id, items);
            ms[b] = sw.ElapsedMilliseconds;
            Assert.Equal(ScaleData.BatchSize, report.Added);
            items = null!;
            heap[b] = GC.GetTotalMemory(true);
            ScaleGate.Log($"load batch {b + 1,2}: append {ms[b],6} ms (generate {gen} ms), heap {heap[b] / 1_048_576.0:F1} MB");
        }
        return new Load(id, ms, heap, await ItemCountAsync(id), (long)ScaleData.BatchSize * ScaleData.ValueChars);
    }

    [Fact]
    public async Task S1_BatchedLoadStaysFlat()
    {
        ScaleGate.SkipUnlessDb();
        var l = await LoadReferenceAsync();
        ScaleGate.Log($"S1 batch ms: {string.Join(", ", l.BatchMs)}");
        ScaleGate.Log($"S1 batch1={l.BatchMs[0]} ms batch20={l.BatchMs[^1]} ms ratio={(double)l.BatchMs[^1] / l.BatchMs[0]:F2} itemCount={l.ItemCount}");
        Assert.True(l.BatchMs[^1] <= 1.5 * l.BatchMs[0], $"batch 20 took {l.BatchMs[^1]} ms, batch 1 {l.BatchMs[0]} ms");
        Assert.Equal(1_000_000, l.ItemCount);
        Assert.Equal(1_000_000, await RowCountAsync(l.CacheId));
    }

    [Fact]
    public async Task S10_MemoryBounded()
    {
        ScaleGate.SkipUnlessDb();
        var l = await LoadReferenceAsync();
        var growth = l.HeapAfter[^1] - l.HeapAfter[1];
        ScaleGate.Log($"S10 heap after batch 2={l.HeapAfter[1] / 1_048_576.0:F1} MB, batch 20={l.HeapAfter[^1] / 1_048_576.0:F1} MB, " +
                      $"growth={growth / 1_048_576.0:F1} MB, one batch payload={l.PayloadBytes / 1_048_576.0:F1} MB, peak={l.HeapAfter.Max() / 1_048_576.0:F1} MB");
        Assert.True(growth < 2 * l.PayloadBytes, $"heap grew {growth} bytes, limit {2 * l.PayloadBytes}");
    }

    [Fact]
    public async Task S3_EightParallelAppends()
    {
        ScaleGate.SkipUnlessDb();
        var id = await NewCacheAsync("s3");
        // 8 batches of 50,000; batch i covers [i*25,000, i*25,000+50,000), so neighbours overlap by half.
        var sw = Stopwatch.StartNew();
        var tasks = Enumerable.Range(0, 8).Select(i => Task.Run(async () =>
        {
            var items = Enumerable.Range(i * 25_000, 50_000)
                .Select(n => new CacheItemDto(ScaleData.Key(n), $"w{i}-{ScaleData.Value(n)}")).ToList();
            return await AppendAsync(id, items);
        })).ToArray();
        var reports = await Task.WhenAll(tasks);
        sw.Stop();

        var union = 7 * 25_000 + 50_000;
        Assert.Equal(union, await ItemCountAsync(id));
        Assert.Equal(union, await RowCountAsync(id));
        Assert.Equal(8 * 50_000, reports.Sum(r => r.Added + r.Overwritten));

        // Each key holds a value one of the writers sent (its prefix names a batch that covers the key).
        await using var db = fixture.NewContext();
        var bad = await db.Database.SqlQuery<long>($@"
            SELECT count(*) AS ""Value"" FROM cache_items
            WHERE cache_id = {id}
              AND NOT (value ~ '^w[0-7]-')").SingleAsync(Ct);
        Assert.Equal(0, bad);
        ScaleGate.Log($"S3 8 parallel x 50,000 overlapping: {sw.ElapsedMilliseconds} ms, rows={union}, added={reports.Sum(r => r.Added)}, overwritten={reports.Sum(r => r.Overwritten)}");
    }

    [Fact]
    public async Task S4_ResendIsAllOverwrite()
    {
        ScaleGate.SkipUnlessDb();
        var l = await LoadReferenceAsync();
        var sw = Stopwatch.StartNew();
        var report = await AppendAsync(l.CacheId, ScaleData.Items(0, ScaleData.BatchSize));
        sw.Stop();
        Assert.Equal(ScaleData.BatchSize, report.Overwritten);
        Assert.Equal(0, report.Added);
        Assert.Equal(1_000_000, await ItemCountAsync(l.CacheId));
        Assert.Equal(1_000_000, await RowCountAsync(l.CacheId));
        ScaleGate.Log($"S4 resend of batch 1 into the 1M cache: {sw.ElapsedMilliseconds} ms, overwritten={report.Overwritten}, added={report.Added}");
    }

    [Fact]
    public async Task S5_RepeatsLastWins()
    {
        ScaleGate.SkipUnlessDb();
        var id = await NewCacheAsync("s5");
        var items = new List<CacheItemDto> { new("a", "first"), new("b", "only"), new("a", "second"), new("a", "last") };
        var report = await AppendAsync(id, items);
        Assert.Equal(2, report.Added);
        Assert.Equal(2, report.RepeatedInBatch);
        Assert.Contains("a", report.RepeatedKeys);
        await using var db = fixture.NewContext();
        var page = await CacheServiceFactory.Create(db, new NullSender()).PageItemsAsync(id, null, null, Ct);
        Assert.Equal("last", page.Items.Single(i => i.Key == "a").Value);
        ScaleGate.Log($"S5 repeats: added={report.Added} repeatedInBatch={report.RepeatedInBatch} repeatedKeys=[{string.Join(",", report.RepeatedKeys)}]");
    }

    [Fact]
    public async Task S6_Remove100kWith1kAbsent()
    {
        ScaleGate.SkipUnlessDb();
        var id = await NewCacheAsync("s6");
        await AppendAsync(id, ScaleData.Items(0, 50_000));
        await AppendAsync(id, ScaleData.Items(50_000, 50_000));
        var keys = Enumerable.Range(0, 99_000).Select(n => ScaleData.Key(n))
            .Concat(Enumerable.Range(5_000_000, 1_000).Select(n => ScaleData.Key(n))).ToList();
        Assert.Equal(100_000, keys.Count);

        await using var db = fixture.NewContext();
        var sw = Stopwatch.StartNew();
        var report = await CacheServiceFactory.Create(db, new NullSender()).RemoveItemsAsync(id, new CacheItemsRemoveDto(keys), Ct);
        sw.Stop();
        Assert.Equal(99_000, report.Removed);
        Assert.Equal(1_000, report.NotFound);
        Assert.Equal(1_000, await ItemCountAsync(id));
        ScaleGate.Log($"S6 remove 100,000 keys (1,000 absent) from a 100k cache: {sw.ElapsedMilliseconds} ms, removed={report.Removed}, notFound={report.NotFound}");
    }

    [Fact]
    public async Task S7_PageAllDuringWrites()
    {
        ScaleGate.SkipUnlessDb();
        var l = await LoadReferenceAsync();
        using var stop = new CancellationTokenSource();
        var writerRounds = 0;
        // The writer only ever touches 'w' keys: they sort after every 'k' key, which are never touched.
        var writer = Task.Run(async () =>
        {
            var round = 0;
            while (!stop.IsCancellationRequested)
            {
                var items = ScaleData.Items(round * 2_000, 2_000, 'w');
                await AppendAsync(l.CacheId, items);
                await using var db = fixture.NewContext();
                await CacheServiceFactory.Create(db, new NullSender())
                    .RemoveItemsAsync(l.CacheId, new CacheItemsRemoveDto(items.Take(1_000).Select(i => i.Key).ToList()), Ct);
                round++;
                writerRounds = round;
            }
        }, Ct);

        var seen = new Dictionary<string, int>();
        string? after = null;
        var pages = 0;
        var pageMs = new List<long>();
        try
        {
            do
            {
                await using var db = fixture.NewContext();
                var sw = Stopwatch.StartNew();
                var page = await CacheServiceFactory.Create(db, new NullSender()).PageItemsAsync(l.CacheId, after, 5_000, Ct);
                pageMs.Add(sw.ElapsedMilliseconds);
                foreach (var i in page.Items) seen[i.Key] = seen.GetValueOrDefault(i.Key) + 1;
                after = page.Next;
                pages++;
            } while (after is not null);
        }
        finally
        {
            stop.Cancel();
            await writer;
        }

        // Clean the writer's leftovers so the cache is the 1M reference again.
        await using (var db = fixture.NewContext())
        {
            await db.Database.ExecuteSqlAsync($"DELETE FROM cache_items WHERE cache_id = {l.CacheId} AND key LIKE 'w%'", Ct);
            await db.Database.ExecuteSqlAsync($"UPDATE caches SET item_count = (SELECT count(*) FROM cache_items WHERE cache_id = {l.CacheId}) WHERE id = {l.CacheId}", Ct);
        }

        var kSeen = seen.Where(p => p.Key[0] == 'k').ToList();
        Assert.Equal(1_000_000, kSeen.Count);
        Assert.All(seen, p => Assert.Equal(1, p.Value));
        ScaleGate.Log($"S7 paged 1M in {pages} pages (limit 5,000), page ms avg={pageMs.Average():F0} max={pageMs.Max()}, writer rounds during the read={writerRounds}, distinct keys seen={seen.Count}");
    }

    [Fact]
    public async Task S9_DeleteMillionCascades()
    {
        ScaleGate.SkipUnlessDb();
        var id = await NewCacheAsync("s9");
        for (var b = 0; b < ScaleData.Batches; b++)
            await AppendAsync(id, ScaleData.Items(b * ScaleData.BatchSize, ScaleData.BatchSize));
        Assert.Equal(1_000_000, await ItemCountAsync(id));

        var before = GC.GetTotalMemory(true);
        await using var db = fixture.NewContext();
        var sw = Stopwatch.StartNew();
        await CacheServiceFactory.Create(db, new NullSender()).DeleteAsync(id, Ct);
        sw.Stop();
        var after = GC.GetTotalMemory(true);

        Assert.Equal(0, await RowCountAsync(id));
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(30), $"delete took {sw.Elapsed}");
        ScaleGate.Log($"S9 delete of the 1M cache: {sw.ElapsedMilliseconds} ms, heap before={before / 1_048_576.0:F1} MB after={after / 1_048_576.0:F1} MB");
    }
}
