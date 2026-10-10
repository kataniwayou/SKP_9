using System.Text.Json;
using Messaging.Contracts.Projections;
using StackExchange.Redis;

namespace BaseApi.Service.Features.Workflow.Delete;

/// <summary>
/// What keeps a workflow's id from being orphaned (2026-10-10): a workflow is deleted only while it is not running,
/// and a start never races a deletion. The live set says whether it runs; a marker held while its deletion runs, and a
/// tombstone after, refuse a start and keep a start message queued earlier from projecting it.
/// </summary>
public interface IWorkflowRunGuard
{
    /// <summary>Whether the workflow is in the live set now.</summary>
    Task<bool> IsLiveAsync(Guid workflowId, CancellationToken ct);

    /// <summary>Whether its deletion is running, or it was deleted: a start of it must not happen.</summary>
    Task<bool> IsDeletingAsync(Guid workflowId, CancellationToken ct);

    /// <summary>Marks its deletion as running (before the deletion's own live check), with a TTL.</summary>
    Task BeginDeleteAsync(Guid workflowId, CancellationToken ct);

    /// <summary>
    /// Its deletion ended. Deleted: its tombstone is set and what it projected is removed (its hash, its cache
    /// dictionaries, its deleted steps' name keys). Either way the running marker goes.
    /// </summary>
    Task EndDeleteAsync(Guid workflowId, bool deleted, IReadOnlyCollection<Guid> deletedSteps, CancellationToken ct);
}

/// <summary>The guard over Redis (<see cref="L2ProjectionKeys"/>).</summary>
internal sealed class RedisWorkflowRunGuard : IWorkflowRunGuard
{
    /// <summary>Long enough for any deletion; a crashed one frees the id again by itself.</summary>
    internal static readonly TimeSpan DeletingTtl = TimeSpan.FromMinutes(2);

    /// <summary>Longer than any start message can wait in the control queue.</summary>
    internal static readonly TimeSpan DeletedTtl = TimeSpan.FromDays(7);

    /// <summary>Set while a workflow's deletion runs, with a TTL (<c>skp:deleting:{id}</c>).</summary>
    internal static string Deleting(Guid workflowId) => $"{L2ProjectionKeys.Prefix}deleting:{workflowId:D}";

    /// <summary>A deleted workflow's tombstone, with a TTL (<c>skp:deleted:{id}</c>).</summary>
    internal static string Deleted(Guid workflowId) => $"{L2ProjectionKeys.Prefix}deleted:{workflowId:D}";

    private readonly IConnectionMultiplexer _multiplexer;

    public RedisWorkflowRunGuard(IConnectionMultiplexer multiplexer)
        => _multiplexer = multiplexer ?? throw new ArgumentNullException(nameof(multiplexer));

    public async Task<bool> IsLiveAsync(Guid workflowId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return await _multiplexer.GetDatabase().SetContainsAsync(L2ProjectionKeys.Live(), workflowId.ToString("D"));
    }

    public async Task<bool> IsDeletingAsync(Guid workflowId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var db = _multiplexer.GetDatabase();
        return await db.KeyExistsAsync(Deleting(workflowId))
               || await db.KeyExistsAsync(Deleted(workflowId));
    }

    public Task BeginDeleteAsync(Guid workflowId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return _multiplexer.GetDatabase().StringSetAsync(
            Deleting(workflowId), "1", DeletingTtl, When.Always, CommandFlags.None);
    }

    public async Task EndDeleteAsync(Guid workflowId, bool deleted, IReadOnlyCollection<Guid> deletedSteps, CancellationToken ct)
    {
        var db = _multiplexer.GetDatabase();
        if (deleted)
        {
            await db.StringSetAsync(Deleted(workflowId), "1", DeletedTtl, When.Always, CommandFlags.None);
            var workflowKey = L2ProjectionKeys.Workflow(workflowId);
            var gone = new List<RedisKey> { workflowKey };
            // its cache dictionaries: the roots its last start recorded, each root's key list, each entry
            foreach (var root in ReadList(await db.HashGetAsync(workflowKey, L2ProjectionKeys.RootsField)).Where(r => !string.IsNullOrWhiteSpace(r)).Distinct(StringComparer.Ordinal))
            {
                var rootKey = L2ProjectionKeys.Cache(workflowId, root);
                gone.Add(rootKey);
                gone.AddRange(ReadList(await db.StringGetAsync(rootKey)).Where(k => !string.IsNullOrEmpty(k)).Distinct(StringComparer.Ordinal)
                    .Select(k => (RedisKey)L2ProjectionKeys.CacheEntry(workflowId, root, k)));
            }
            // its steps' name keys: their rows are gone with it
            gone.AddRange(deletedSteps.Select(s => (RedisKey)L2ProjectionKeys.StepEntity(s)));
            await db.KeyDeleteAsync(gone.ToArray());
        }
        await db.KeyDeleteAsync(Deleting(workflowId));
    }

    private static List<string> ReadList(RedisValue json)
    {
        if (json.IsNullOrEmpty) return [];
        try
        {
            return JsonSerializer.Deserialize<List<string>>(json.ToString()) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }
}
