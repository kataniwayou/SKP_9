using System.Data.Common;
using BaseApi.Core.Exceptions;
using BaseApi.Core.Persistence;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Npgsql;
using NpgsqlTypes;

namespace BaseApi.Service.Features.Cache;

/// <summary>
/// The set-based SQL over <c>cache_items</c>: append (upsert), remove, keyset paging and reads. Every
/// statement's cost grows with the batch or the page, never with the whole cache, so a cache can hold far
/// more than one request carries.
/// <para>
/// Append and remove start with an <c>UPDATE caches … WHERE id = @id</c> that stamps the audit columns
/// and, as the first statement of the transaction, takes the cache row's lock: concurrent writers to one
/// cache serialize rather than conflict, and cannot deadlock on overlapping keys. It also answers
/// "does the cache exist" (0 rows is a <see cref="NotFoundException"/>). The cache's <c>item_count</c> is
/// then moved by exactly what the batch added or removed.
/// </para>
/// <para>
/// When the context has a transaction current (<c>POST /model/apply</c> runs this inside its own, with
/// savepoints) the work joins it and does not commit; otherwise the store opens its own and commits.
/// </para>
/// <para>
/// It is SQL only: a <see cref="CacheEntity"/> already tracked by the context keeps its old
/// <c>UpdatedAt</c>, <c>UpdatedBy</c> and <c>ItemCount</c> until it is reloaded. Callers that go on to save
/// that entity should reload it first (or not track it): saving it after an append or remove in the same
/// context throws a concurrency conflict, because the row's <c>xmin</c> moved.
/// </para>
/// </summary>
public sealed class CacheItemsStore(BaseDbContext db, TimeProvider clock, IHttpContextAccessor http)
{
    /// <summary>
    /// Most rows one statement carries. One statement over a whole 50,000-item batch (two <c>text[]</c>
    /// parameters of ~25 MB) is what the database holds in memory at once; slices keep that small. All
    /// slices run in the one transaction, after the stamp.
    /// </summary>
    public const int SliceSize = 5_000;

    private const string StampSql =
        "UPDATE caches SET updated_at = @now, updated_by = @user, item_count = item_count WHERE id = @id";

    private const string ExistingSql =
        "SELECT key FROM cache_items WHERE cache_id = @id AND key = ANY(@keys)";

    private const string UpsertSql = """
        INSERT INTO cache_items (cache_id, key, value)
        SELECT @id, k, v FROM unnest(@keys::text[], @values::text[]) AS t(k, v)
        ON CONFLICT (cache_id, key) DO UPDATE SET value = excluded.value
          WHERE cache_items.value IS DISTINCT FROM excluded.value
        """;

    private const string DeleteSql =
        "DELETE FROM cache_items WHERE cache_id = @id AND key = ANY(@keys) RETURNING key";

    private const string CountSql = "UPDATE caches SET item_count = item_count + @delta WHERE id = @id";

    /// <summary>Adds the pairs, overwriting a key already stored; a key repeated in the batch keeps its last value.</summary>
    public async Task<CacheAppendReport> AppendAsync(Guid cacheId, IReadOnlyList<CacheItemDto> items, CancellationToken ct)
    {
        var (unique, repeated) = LastWins(items);
        var keys = unique.Select(i => i.Key).ToArray();

        var existing = await InTransactionAsync(async (conn, tx) =>
        {
            await StampAsync(conn, tx, cacheId, ct);

            var found = new HashSet<string>(StringComparer.Ordinal);
            foreach (var slice in Slices(unique, SliceSize))
            {
                var sliceKeys = slice.Select(i => i.Key).ToArray();
                var sliceValues = slice.Select(i => i.Value).ToArray();

                await using (var cmd = Command(conn, tx, ExistingSql, cacheId, sliceKeys))
                await using (var reader = await cmd.ExecuteReaderAsync(ct))
                    while (await reader.ReadAsync(ct)) found.Add(reader.GetString(0));

                await using (var cmd = Command(conn, tx, UpsertSql, cacheId, sliceKeys))
                {
                    cmd.Parameters.Add(new NpgsqlParameter("values", NpgsqlDbType.Array | NpgsqlDbType.Text) { Value = sliceValues });
                    await cmd.ExecuteNonQueryAsync(ct);
                }
            }

            var added = keys.Length - found.Count;
            if (added != 0) await AddToCountAsync(conn, tx, cacheId, added, ct);
            return found;
        }, ct);

        // Batch order, not hash order, so the report is stable.
        var overwrittenKeys = keys.Where(existing.Contains).ToList();
        var truncated = overwrittenKeys.Count > CacheRules.ReportKeyCap || repeated.Count > CacheRules.ReportKeyCap;
        return new CacheAppendReport(
            Added: keys.Length - existing.Count,
            Overwritten: existing.Count,
            RepeatedInBatch: items.Count - keys.Length,
            OverwrittenKeys: Cap(overwrittenKeys),
            RepeatedKeys: Cap(repeated),
            KeysTruncated: truncated);
    }

    /// <summary>Drops the keys; a key not stored is reported, not an error. A key repeated in the batch counts once.</summary>
    public async Task<CacheRemoveReport> RemoveAsync(Guid cacheId, IReadOnlyList<string> keys, CancellationToken ct)
    {
        var (unique, repeated) = Distinct(keys);

        var removed = await InTransactionAsync(async (conn, tx) =>
        {
            await StampAsync(conn, tx, cacheId, ct);

            var gone = new HashSet<string>(StringComparer.Ordinal);
            foreach (var slice in Slices(unique, SliceSize))
            {
                await using var cmd = Command(conn, tx, DeleteSql, cacheId, slice.ToArray());
                await using var reader = await cmd.ExecuteReaderAsync(ct);
                while (await reader.ReadAsync(ct)) gone.Add(reader.GetString(0));
            }

            if (gone.Count != 0) await AddToCountAsync(conn, tx, cacheId, -gone.Count, ct);
            return gone;
        }, ct);

        var notFoundKeys = unique.Where(k => !removed.Contains(k)).ToList();
        var truncated = notFoundKeys.Count > CacheRules.ReportKeyCap || repeated.Count > CacheRules.ReportKeyCap;
        return new CacheRemoveReport(
            Removed: removed.Count,
            NotFound: notFoundKeys.Count,
            RepeatedInBatch: keys.Count - unique.Count,
            NotFoundKeys: Cap(notFoundKeys),
            RepeatedKeys: Cap(repeated),
            KeysTruncated: truncated);
    }

    /// <summary>
    /// One page ordered by the database's order of <c>key</c> (the column's collation, which the primary-key
    /// index serves), after the cursor <paramref name="after"/>. <c>Next</c> is the last key returned when
    /// more follow, else null. The caller bounds <paramref name="limit"/>.
    /// <para>
    /// A page is also bounded by <paramref name="charBudget"/> (default <see cref="CacheRules.PageCharBudget"/>):
    /// rows are taken in order while the running key + value character count stays within it, so it may hold
    /// fewer than <paramref name="limit"/> rows with <c>Next</c> set. The first row is always taken, even when
    /// it alone passes the budget, so paging always advances. To keep the database and BaseApi from holding
    /// <paramref name="limit"/> large values at once, the cut is chosen from keys and <c>char_length(value)</c>
    /// first, and only the chosen rows' values are then read. Outside a transaction the two reads are separate
    /// snapshots: a row removed between them is simply missing from the page, which the keyset cursor tolerates.
    /// </para>
    /// </summary>
    public Task<CacheItemsPage> PageAsync(Guid cacheId, string? after, int limit, CancellationToken ct,
        long charBudget = CacheRules.PageCharBudget) =>
        PageAsync(cacheId, after is null ? CachePageAt.First : new CachePageAt(CachePageMode.After, after), limit, ct, charBudget);

    /// <summary>
    /// The same page read from <paramref name="at"/>: the start, after a key, from a key (the first key
    /// &gt;= it; when none is, the last page, <c>FromMatch</c> "none"), or the rows before a key (ascending,
    /// the <paramref name="limit"/> rows nearest it). <c>Index</c> counts the keys before the first row
    /// returned. The character budget cuts from the end nearest the anchor, so a <see cref="CachePageMode.Before"/>
    /// page keeps its rows next to the anchor.
    /// </summary>
    public Task<CacheItemsPage> PageAsync(Guid cacheId, CachePageAt at, int limit, CancellationToken ct,
        long charBudget = CacheRules.PageCharBudget) =>
        ReadingAsync(async (conn, tx) =>
        {
            long itemCount;
            await using (var exists = Command(conn, tx, "SELECT item_count FROM caches WHERE id = @id"))
            {
                exists.Parameters.AddWithValue("id", cacheId);
                if (await exists.ExecuteScalarAsync(ct) is not { } c) throw new NotFoundException(nameof(CacheEntity), cacheId);
                itemCount = Convert.ToInt64(c);
            }

            const string cols = "SELECT key, char_length(key) + char_length(value) FROM cache_items WHERE cache_id = @id";
            var backwards = at.Mode == CachePageMode.Before;
            var sizesSql = at.Mode switch
            {
                CachePageMode.After => $"{cols} AND key > @k ORDER BY key LIMIT @n",
                CachePageMode.From => $"{cols} AND key >= @k ORDER BY key LIMIT @n",
                CachePageMode.Before => $"{cols} AND key < @k ORDER BY key DESC LIMIT @n",
                _ => $"{cols} ORDER BY key LIMIT @n",
            };

            async Task<List<(string Key, long Chars)>> CandidatesAsync(string sql, bool withKey, int n)
            {
                var list = new List<(string Key, long Chars)>();
                await using var cmd = Command(conn, tx, sql);
                cmd.Parameters.AddWithValue("id", cacheId);
                if (withKey) cmd.Parameters.AddWithValue("k", NpgsqlDbType.Varchar, at.Key!);
                cmd.Parameters.AddWithValue("n", n);
                await using var reader = await cmd.ExecuteReaderAsync(ct);
                while (await reader.ReadAsync(ct)) list.Add((reader.GetString(0), Convert.ToInt64(reader.GetValue(1))));
                return list;
            }

            // Forward modes read one extra row to know whether another page follows; Before reads just the page.
            var candidates = await CandidatesAsync(sizesSql, at.Mode != CachePageMode.Start, backwards ? limit : limit + 1);
            string? fromMatch = null;
            if (at.Mode == CachePageMode.From)
            {
                if (candidates.Count == 0)
                {
                    // No key at or after it: the last page, read from the far end.
                    backwards = true;
                    fromMatch = "none";
                    candidates = await CandidatesAsync($"{cols} ORDER BY key DESC LIMIT @n", false, limit);
                }
                else
                {
                    // Decided by the database: the column's collation says what "equal" is.
                    await using var eq = Command(conn, tx, "SELECT EXISTS (SELECT 1 FROM cache_items WHERE cache_id = @id AND key = @k)");
                    eq.Parameters.AddWithValue("id", cacheId);
                    eq.Parameters.AddWithValue("k", NpgsqlDbType.Varchar, at.Key!);
                    fromMatch = (bool)(await eq.ExecuteScalarAsync(ct))! ? "exact" : "later";
                }
            }

            var take = CutByBudget(candidates.Select(c => c.Chars).Take(limit).ToList(), charBudget);
            var chosen = candidates.Take(take).Select(c => c.Key).ToArray();
            if (backwards) Array.Reverse(chosen);
            if (chosen.Length == 0) return new CacheItemsPage([], null, null, at.Mode == CachePageMode.Before ? 0 : itemCount, fromMatch);

            var values = new Dictionary<string, string>(chosen.Length, StringComparer.Ordinal);
            await using (var cmd = Command(conn, tx, "SELECT key, value FROM cache_items WHERE cache_id = @id AND key = ANY(@keys)", cacheId, chosen))
            await using (var reader = await cmd.ExecuteReaderAsync(ct))
                while (await reader.ReadAsync(ct)) values[reader.GetString(0)] = reader.GetString(1);

            var page = chosen.Where(values.ContainsKey).Select(k => new CacheItemDto(k, values[k])).ToList();

            bool more;
            if (backwards)
            {
                await using var follow = Command(conn, tx, "SELECT EXISTS (SELECT 1 FROM cache_items WHERE cache_id = @id AND key > @k)");
                follow.Parameters.AddWithValue("id", cacheId);
                follow.Parameters.AddWithValue("k", NpgsqlDbType.Varchar, chosen[^1]);
                more = (bool)(await follow.ExecuteScalarAsync(ct))!;
            }
            else more = candidates.Count > take;

            // the start page begins at the first key: nothing sorts before it, so no count
            long index = 0;
            if (at.Mode != CachePageMode.Start)
            {
                await using var before = Command(conn, tx, "SELECT count(*) FROM cache_items WHERE cache_id = @id AND key < @k");
                before.Parameters.AddWithValue("id", cacheId);
                before.Parameters.AddWithValue("k", NpgsqlDbType.Varchar, chosen[0]);
                index = Convert.ToInt64(await before.ExecuteScalarAsync(ct));
            }

            return new CacheItemsPage(page, more ? chosen[^1] : null, index > 0 ? chosen[0] : null, index, fromMatch);
        }, ct);

    /// <summary>
    /// How many of the leading rows (their key + value character counts, in page order) fit in
    /// <paramref name="budget"/>: rows are counted while the running total stays within it, and the first is
    /// always counted.
    /// </summary>
    public static int CutByBudget(IReadOnlyList<long> chars, long budget)
    {
        long total = 0;
        for (var i = 0; i < chars.Count; i++)
        {
            total += chars[i];
            if (total > budget && i > 0) return i;
        }
        return chars.Count;
    }

    /// <summary>Every item of the cache. Memory grows with the cache: for callers that already need all of it.</summary>
    public Task<Dictionary<string, string>> ReadAllAsync(Guid cacheId, CancellationToken ct) =>
        ReadingAsync(async (conn, tx) =>
        {
            var all = new Dictionary<string, string>(StringComparer.Ordinal);
            await using var cmd = Command(conn, tx, "SELECT key, value FROM cache_items WHERE cache_id = @id");
            cmd.Parameters.AddWithValue("id", cacheId);
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct)) all[reader.GetString(0)] = reader.GetString(1);
            return all;
        }, ct);

    /// <summary>The current value of each named key; null for a key not stored.</summary>
    public Task<Dictionary<string, string?>> ReadKeysAsync(Guid cacheId, IReadOnlyCollection<string> keys, CancellationToken ct) =>
        ReadingAsync(async (conn, tx) =>
        {
            var result = new Dictionary<string, string?>(StringComparer.Ordinal);
            foreach (var k in keys) result[k] = null;
            await using var cmd = Command(conn, tx, "SELECT key, value FROM cache_items WHERE cache_id = @id AND key = ANY(@keys)");
            cmd.Parameters.AddWithValue("id", cacheId);
            cmd.Parameters.Add(new NpgsqlParameter("keys", NpgsqlDbType.Array | NpgsqlDbType.Text) { Value = result.Keys.ToArray() });
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct)) result[reader.GetString(0)] = reader.GetString(1);
            return result;
        }, ct);

    /// <summary>
    /// Collapses a key repeated in the batch: one entry per key, in first-seen order, carrying the last value.
    /// <c>Repeated</c> names each key that appeared more than once. (Postgres refuses an <c>ON CONFLICT</c>
    /// statement that touches one row twice, so this must happen before the SQL.)
    /// </summary>
    public static (List<CacheItemDto> Items, List<string> Repeated) LastWins(IReadOnlyList<CacheItemDto> items)
    {
        var index = new Dictionary<string, int>(items.Count, StringComparer.Ordinal);
        var unique = new List<CacheItemDto>(items.Count);
        var repeated = new List<string>();
        var named = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in items)
        {
            if (index.TryGetValue(item.Key, out var at))
            {
                unique[at] = item;
                if (named.Add(item.Key)) repeated.Add(item.Key);
            }
            else
            {
                index[item.Key] = unique.Count;
                unique.Add(item);
            }
        }
        return (unique, repeated);
    }

    /// <summary>The keys, each once in first-seen order; <c>Repeated</c> names each key that appeared more than once.</summary>
    public static (List<string> Keys, List<string> Repeated) Distinct(IReadOnlyList<string> keys)
    {
        var seen = new HashSet<string>(keys.Count, StringComparer.Ordinal);
        var named = new HashSet<string>(StringComparer.Ordinal);
        var unique = new List<string>(keys.Count);
        var repeated = new List<string>();
        foreach (var key in keys)
        {
            if (seen.Add(key)) unique.Add(key);
            else if (named.Add(key)) repeated.Add(key);
        }
        return (unique, repeated);
    }

    /// <summary>The list cut into runs of at most <paramref name="size"/>, in order.</summary>
    public static IEnumerable<IReadOnlyList<T>> Slices<T>(IReadOnlyList<T> list, int size)
    {
        for (var at = 0; at < list.Count; at += size)
        {
            var take = Math.Min(size, list.Count - at);
            var slice = new T[take];
            for (var i = 0; i < take; i++) slice[i] = list[at + i];
            yield return slice;
        }
    }

    private static List<string> Cap(List<string> names) =>
        names.Count <= CacheRules.ReportKeyCap ? names : names.GetRange(0, CacheRules.ReportKeyCap);

    private async Task StampAsync(DbConnection conn, DbTransaction tx, Guid cacheId, CancellationToken ct)
    {
        await using var cmd = Command(conn, tx, StampSql);
        cmd.Parameters.AddWithValue("now", NpgsqlDbType.TimestampTz, clock.GetUtcNow().UtcDateTime);
        // Raw SQL bypasses the audit interceptor, so set what it would: the signed-in name, null off the HTTP path.
        cmd.Parameters.AddWithValue("user", NpgsqlDbType.Text, (object?)http.HttpContext?.User?.Identity?.Name ?? DBNull.Value);
        cmd.Parameters.AddWithValue("id", cacheId);
        if (await cmd.ExecuteNonQueryAsync(ct) == 0) throw new NotFoundException(nameof(CacheEntity), cacheId);
    }

    private static async Task AddToCountAsync(DbConnection conn, DbTransaction tx, Guid cacheId, int delta, CancellationToken ct)
    {
        await using var cmd = Command(conn, tx, CountSql);
        cmd.Parameters.AddWithValue("delta", delta);
        cmd.Parameters.AddWithValue("id", cacheId);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static NpgsqlCommand Command(DbConnection conn, DbTransaction? tx, string sql) =>
        new(sql, (NpgsqlConnection)conn, (NpgsqlTransaction?)tx);

    /// <summary>A command with <c>@id</c> and a <c>text[]</c> <c>@keys</c>.</summary>
    private static NpgsqlCommand Command(DbConnection conn, DbTransaction? tx, string sql, Guid cacheId, string[] keys)
    {
        var cmd = Command(conn, tx, sql);
        cmd.Parameters.AddWithValue("id", cacheId);
        cmd.Parameters.Add(new NpgsqlParameter("keys", NpgsqlDbType.Array | NpgsqlDbType.Text) { Value = keys });
        return cmd;
    }

    /// <summary>Runs in the current transaction (without committing it) or, when there is none, in one of its own.</summary>
    private async Task<T> InTransactionAsync<T>(Func<DbConnection, DbTransaction, Task<T>> work, CancellationToken ct)
    {
        if (db.Database.CurrentTransaction is { } current)
            return await work(db.Database.GetDbConnection(), current.GetDbTransaction());

        await using var own = await db.Database.BeginTransactionAsync(ct);
        var result = await work(db.Database.GetDbConnection(), own.GetDbTransaction());
        await own.CommitAsync(ct);
        return result;
    }

    /// <summary>A read: joins the current transaction if there is one, else uses the connection bare.</summary>
    private async Task<T> ReadingAsync<T>(Func<DbConnection, DbTransaction?, Task<T>> work, CancellationToken ct)
    {
        await db.Database.OpenConnectionAsync(ct);
        try
        {
            return await work(db.Database.GetDbConnection(), db.Database.CurrentTransaction?.GetDbTransaction());
        }
        finally
        {
            await db.Database.CloseConnectionAsync();
        }
    }
}
