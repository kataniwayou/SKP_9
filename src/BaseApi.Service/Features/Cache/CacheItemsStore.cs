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
/// that entity should reload it first (or not track it).
/// </para>
/// </summary>
internal sealed class CacheItemsStore(BaseDbContext db, TimeProvider clock, IHttpContextAccessor http)
{
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
        var values = unique.Select(i => i.Value).ToArray();

        var existing = await InTransactionAsync(async (conn, tx) =>
        {
            await StampAsync(conn, tx, cacheId, ct);

            var found = new HashSet<string>(StringComparer.Ordinal);
            await using (var cmd = Command(conn, tx, ExistingSql, cacheId, keys))
            await using (var reader = await cmd.ExecuteReaderAsync(ct))
                while (await reader.ReadAsync(ct)) found.Add(reader.GetString(0));

            await using (var cmd = Command(conn, tx, UpsertSql, cacheId, keys))
            {
                cmd.Parameters.Add(new NpgsqlParameter("values", NpgsqlDbType.Array | NpgsqlDbType.Text) { Value = values });
                await cmd.ExecuteNonQueryAsync(ct);
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
        var arr = unique.ToArray();

        var removed = await InTransactionAsync(async (conn, tx) =>
        {
            await StampAsync(conn, tx, cacheId, ct);

            var gone = new HashSet<string>(StringComparer.Ordinal);
            await using (var cmd = Command(conn, tx, DeleteSql, cacheId, arr))
            await using (var reader = await cmd.ExecuteReaderAsync(ct))
                while (await reader.ReadAsync(ct)) gone.Add(reader.GetString(0));

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
    /// </summary>
    public Task<CacheItemsPage> PageAsync(Guid cacheId, string? after, int limit, CancellationToken ct) =>
        ReadingAsync(async (conn, tx) =>
        {
            await using (var exists = Command(conn, tx, "SELECT 1 FROM caches WHERE id = @id"))
            {
                exists.Parameters.AddWithValue("id", cacheId);
                if (await exists.ExecuteScalarAsync(ct) is null) throw new NotFoundException(nameof(CacheEntity), cacheId);
            }

            var sql = after is null
                ? "SELECT key, value FROM cache_items WHERE cache_id = @id ORDER BY key LIMIT @n"
                : "SELECT key, value FROM cache_items WHERE cache_id = @id AND key > @after ORDER BY key LIMIT @n";
            var page = new List<CacheItemDto>();
            await using var cmd = Command(conn, tx, sql);
            cmd.Parameters.AddWithValue("id", cacheId);
            if (after is not null) cmd.Parameters.AddWithValue("after", NpgsqlDbType.Varchar, after);
            cmd.Parameters.AddWithValue("n", limit + 1); // one extra says whether another page follows
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct)) page.Add(new CacheItemDto(reader.GetString(0), reader.GetString(1)));

            if (page.Count <= limit) return new CacheItemsPage(page, null);
            page.RemoveAt(page.Count - 1);
            return new CacheItemsPage(page, page[^1].Key);
        }, ct);

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
