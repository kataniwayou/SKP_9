using System.Text.Json;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using StackExchange.Redis;

namespace BaseApi.Service.Features.Orchestration.Projection;

/// <summary>
/// Writes one workflow into L2 and aligns every entity that participates in it with the database:
/// <c>skp:wf:{id}</c> (name, store, roots), its cache dictionaries, and each of its steps' names.
/// <para>
/// <b>Added and kept participants are overwritten; removed ones follow the database.</b> The previous
/// start's participants are read back from what it recorded (the <c>store</c>'s step ids, the
/// <c>roots</c> field and each root's key list) and compared with this start's:
/// </para>
/// <list type="bullet">
///   <item><description>cache roots no longer bound and cache items no longer held are deleted — those
///   keys belong to this workflow alone;</description></item>
///   <item><description>a step this workflow dropped loses its <c>skp:step:{id}</c> key only when its
///   database row is gone. Every reference to a step is <c>ON DELETE RESTRICT</c>, so a missing row means
///   no workflow references it any more; a dropped step that still exists may belong to another
///   workflow and keeps its key.</description></item>
/// </list>
/// <para>
/// Processors and schemas are not aligned here: each processor instance owns its own keys, and
/// schemas have none.
/// </para>
/// <para>
/// <b>One batch, and the delete goes first in it.</b> A batch is pipelined, not MULTI: a connection that
/// dies part-way through leaves a prefix of it applied. The leftovers are computed from the
/// <c>store</c>, the <c>roots</c> field and the key lists the previous start recorded, and this batch
/// overwrites all three — so
/// were the delete queued last, a batch torn after the writes would leave the NEW records in place, the
/// rerun would find no leftovers, and a removed item would stay readable for good. Queued first, and
/// commands on one connection apply in order, any torn prefix either has not deleted yet or has deleted
/// with the old records still intact; the rerun reads the same previous state and computes the same
/// leftovers. The deletes and the writes are disjoint by construction, so putting the delete first
/// costs nothing. A failure requeues the control message and the whole method runs again.
/// </para>
/// </summary>
internal sealed class L2ProjectionWriter
{
    private readonly IConnectionMultiplexer _multiplexer;
    private readonly IStepRowLookup _stepRows;

    public L2ProjectionWriter(IConnectionMultiplexer multiplexer, IStepRowLookup stepRows)
    {
        _multiplexer = multiplexer ?? throw new ArgumentNullException(nameof(multiplexer));
        _stepRows    = stepRows ?? throw new ArgumentNullException(nameof(stepRows));
    }

    public async Task WriteAsync(WorkflowL1 workflow, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(workflow);

        var db = _multiplexer.GetDatabase();
        var workflowId = workflow.WorkflowId;
        var workflowKey = L2ProjectionKeys.Workflow(workflowId);
        var steps = workflow.Steps ?? new List<StepL1>();

        // Deduplicated by root, blank roots dropped — unchanged from the previous writer, for the same
        // reason: a root written twice or blank is a key set nothing would find again.
        var caches = (workflow.Caches ?? new List<CacheL1>())
            .Where(c => !string.IsNullOrWhiteSpace(c.Root))
            .GroupBy(c => c.Root, StringComparer.Ordinal)
            .Select(g => g.First())
            .ToList();

        var stale = await FindOwnLeftoversAsync(db, workflowId, workflowKey, caches).ConfigureAwait(false);
        stale.AddRange(await FindRemovedStepsAsync(db, workflowKey, steps, ct).ConfigureAwait(false));

        var store = new WorkflowStoreProjection(workflow.EntryStepIds ?? new List<Guid>(), steps, workflow.EntryCrons);

        var batch = db.CreateBatch();
        var writes = new List<Task>();

        // FIRST, before anything that overwrites the records the leftovers were computed from — see the
        // class summary: a batch torn after this point still leaves the rerun the same previous state.
        if (stale.Count > 0)
        {
            writes.Add(batch.KeyDeleteAsync(stale.ToArray()));
        }

        writes.Add(batch.HashSetAsync(workflowKey,
        [
            new HashEntry(L2ProjectionKeys.StoreField, JsonSerializer.Serialize(store, MessagingJson.Options)),
            new HashEntry(L2ProjectionKeys.RootsField,
                JsonSerializer.Serialize(caches.Select(c => c.Root).ToList(), MessagingJson.Options)),
        ]));

        foreach (var cache in caches)
        {
            var items = cache.Items ?? new Dictionary<string, string>();

            // The root is only the "was projected" marker (a processor tells an absent root from an
            // empty whitelist by it); the key names go in the set, so the next start, a delete and an
            // incremental apply can find them without parsing a list.
            writes.Add(batch.StringSetAsync(L2ProjectionKeys.Cache(workflowId, cache.Root), EmptyMarker));
            writes.AddRange(QueueKeySet(batch, L2ProjectionKeys.CacheKeySet(workflowId, cache.Root), items.Keys));

            foreach (var (key, value) in items)
            {
                writes.Add(batch.StringSetAsync(L2ProjectionKeys.CacheEntry(workflowId, cache.Root, key), value));
            }
        }

        // THE NAMES, in the same pipelined batch, each on its own entity hash. Only the workflow and its
        // own steps: an id that is neither has no key this start owns. A name key is deleted only by
        // FindRemovedStepsAsync, for a dropped step whose row is gone -- never because another workflow
        // or a stop stopped using it, since entities are shared and records keep arriving after a stop.
        // A null guard, not `?? new Dictionary<...>()`: that fallback inside a deconstructing foreach
        // crashes Roslyn's IDE0028 analyzer (AD0001), which fails the Release build under
        // EnforceCodeStyleInBuild + TreatWarningsAsErrors.
        if (workflow.Names is not null)
        {
            var stepIds = steps.Select(s => s.StepId).ToHashSet();
            foreach (var (id, name) in workflow.Names)
            {
                L2EntityKind? kind = id == workflow.WorkflowId ? L2EntityKind.Workflow
                    : stepIds.Contains(id) ? L2EntityKind.Step
                    : null;

                if (kind is { } k)
                {
                    writes.Add(batch.HashSetAsync(L2ProjectionKeys.Entity(k, id), L2ProjectionKeys.NameField, name));
                }
            }
        }

        batch.Execute();
        await Task.WhenAll(writes).ConfigureAwait(false);
    }

    /// <summary>
    /// Aligns one cache's dictionary of an already projected workflow with the row, and nothing else:
    /// the store, the roots field, the names and every other cache stay as the start wrote them.
    /// <para>
    /// <b>Only a root the workflow's last start recorded is written</b>, and false is returned otherwise.
    /// A cache bound after the start is a binding change, which waits for the next start like every
    /// other; writing it here would hand the running workflow a dictionary its start never had.
    /// </para>
    /// <para>
    /// <b>The same discipline as <see cref="WriteAsync"/>: one batch, the delete first.</b> The leftovers
    /// are computed from the root's key list, which this batch overwrites, so a batch torn after the
    /// delete leaves the rerun the same previous state.
    /// </para>
    /// </summary>
    public async Task<bool> WriteCacheAsync(Guid workflowId, CacheL1 cache, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(cache);
        ct.ThrowIfCancellationRequested();

        var db = _multiplexer.GetDatabase();

        var roots = ReadList(await db.HashGetAsync(L2ProjectionKeys.Workflow(workflowId), L2ProjectionKeys.RootsField)
            .ConfigureAwait(false));
        if (!roots.Contains(cache.Root, StringComparer.Ordinal))
        {
            return false;
        }

        var rootKey = L2ProjectionKeys.Cache(workflowId, cache.Root);
        var setKey = L2ProjectionKeys.CacheKeySet(workflowId, cache.Root);
        var items = cache.Items ?? new Dictionary<string, string>();

        var stale = (await ReadKeyNamesAsync(db, workflowId, cache.Root).ConfigureAwait(false))
            .Where(k => !string.IsNullOrEmpty(k) && !items.ContainsKey(k))
            .Distinct(StringComparer.Ordinal)
            .Select(k => (RedisKey)L2ProjectionKeys.CacheEntry(workflowId, cache.Root, k))
            .Append(setKey)
            .ToArray();

        var batch = db.CreateBatch();
        var writes = new List<Task>
        {
            // The stale entries and the old set go in one DEL, first; the set is rebuilt below.
            batch.KeyDeleteAsync(stale),
            batch.StringSetAsync(rootKey, EmptyMarker),
        };

        writes.AddRange(QueueKeySet(batch, setKey, items.Keys));

        foreach (var (key, value) in items)
        {
            writes.Add(batch.StringSetAsync(L2ProjectionKeys.CacheEntry(workflowId, cache.Root, key), value));
        }

        batch.Execute();
        await Task.WhenAll(writes).ConfigureAwait(false);
        return true;
    }

    /// <summary>
    /// Applies a delta to one cache of an already projected workflow: each key with a value is written
    /// (<c>SET entry</c> + <c>SADD</c>), each key with a null value is dropped (<c>DEL entry</c> +
    /// <c>SREM</c>). Nothing else is read or written, so the cost follows the keys passed - except once
    /// per cache after the deploy that introduced the key set: a root still holding the old JSON list
    /// has no set, so the set is seeded from that list and the root rewritten to the <c>[]</c> marker.
    /// <para>
    /// False, with nothing written, when the root is not among the workflow's <c>roots</c> (never
    /// started, or bound after the start - see <see cref="WriteCacheAsync"/>).
    /// </para>
    /// <para>
    /// <b>One batch, deletes first, idempotent.</b> The seed's SADD precedes the root rewrite, so a torn
    /// batch leaves either the legacy root (the rerun seeds again) or both. Applying the same delta twice
    /// leaves the same L2, which is what a redelivered refresh needs.
    /// </para>
    /// </summary>
    public async Task<bool> ApplyCacheKeysAsync(
        Guid workflowId, string root, IReadOnlyDictionary<string, string?> current, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(root);
        ArgumentNullException.ThrowIfNull(current);
        ct.ThrowIfCancellationRequested();

        var db = _multiplexer.GetDatabase();

        var roots = ReadList(await db.HashGetAsync(L2ProjectionKeys.Workflow(workflowId), L2ProjectionKeys.RootsField)
            .ConfigureAwait(false));
        if (!roots.Contains(root, StringComparer.Ordinal))
        {
            return false;
        }

        var rootKey = L2ProjectionKeys.Cache(workflowId, root);
        var setKey = L2ProjectionKeys.CacheKeySet(workflowId, root);

        // The legacy seed: no set yet, and a root that lists names. An empty or marker root seeds nothing.
        List<string> legacy = [];
        if (!await db.KeyExistsAsync(setKey).ConfigureAwait(false))
        {
            legacy = ReadList(await db.StringGetAsync(rootKey).ConfigureAwait(false))
                .Where(k => !string.IsNullOrEmpty(k))
                .Distinct(StringComparer.Ordinal)
                .ToList();
        }

        var dropped = current.Where(p => p.Value is null && !string.IsNullOrEmpty(p.Key)).Select(p => p.Key).ToList();
        var written = current.Where(p => p.Value is not null && !string.IsNullOrEmpty(p.Key)).ToList();

        var batch = db.CreateBatch();
        var writes = new List<Task>();

        if (dropped.Count > 0)
        {
            writes.Add(batch.KeyDeleteAsync(
                dropped.Select(k => (RedisKey)L2ProjectionKeys.CacheEntry(workflowId, root, k)).ToArray()));
        }

        if (legacy.Count > 0)
        {
            writes.AddRange(QueueKeySet(batch, setKey, legacy));
        }

        foreach (var (key, value) in written)
        {
            writes.Add(batch.StringSetAsync(L2ProjectionKeys.CacheEntry(workflowId, root, key), value!));
        }

        writes.AddRange(QueueKeySet(batch, setKey, written.Select(p => p.Key)));

        if (dropped.Count > 0)
        {
            writes.Add(batch.SetRemoveAsync(setKey, dropped.Select(k => (RedisValue)k).ToArray()));
        }

        if (legacy.Count > 0)
        {
            // Last: only once the names are in the set is the root reduced to the marker.
            writes.Add(batch.StringSetAsync(rootKey, EmptyMarker));
        }

        batch.Execute();
        await Task.WhenAll(writes).ConfigureAwait(false);
        return true;
    }

    /// <summary>The root's content now: the "was projected" marker, an empty JSON list.</summary>
    private const string EmptyMarker = "[]";

    /// <summary>SADD in chunks, so a large dictionary is not one oversized command.</summary>
    private static IEnumerable<Task> QueueKeySet(IBatch batch, string setKey, IEnumerable<string> names)
    {
        foreach (var chunk in names.Where(k => !string.IsNullOrEmpty(k)).Distinct(StringComparer.Ordinal).Chunk(1000))
        {
            yield return batch.SetAddAsync(setKey, chunk.Select(k => (RedisValue)k).ToArray());
        }
    }

    /// <summary>
    /// The key names of one projected dictionary: the union of the set's members and the root's JSON list
    /// (how a start before the key set existed recorded them). Both are read, not "set, else list": during a
    /// rolling overlap an old pod can rewrite the root as a list while the set exists, and a name only in
    /// the list would otherwise leak its entry. A new root holds the <c>[]</c> marker, so the list adds
    /// nothing then. <c>WorkflowRunGuard</c> reads the same union.
    /// </summary>
    private static async Task<List<string>> ReadKeyNamesAsync(IDatabase db, Guid workflowId, string root)
    {
        var members = await db.SetMembersAsync(L2ProjectionKeys.CacheKeySet(workflowId, root)).ConfigureAwait(false);
        var legacy = ReadList(await db.StringGetAsync(L2ProjectionKeys.Cache(workflowId, root)).ConfigureAwait(false));
        return members.Select(m => m.ToString()).Concat(legacy).Distinct(StringComparer.Ordinal).ToList();
    }

    /// <summary>
    /// The step name keys of steps this workflow dropped since its previous start and the database no
    /// longer holds. Only the dropped steps are looked up — kept and added steps are participants, so
    /// they exist by definition — and a start that dropped nothing makes no database read. A previous
    /// store that is missing or unreadable contributes nothing: without it there is no record of what
    /// was dropped, and deleting on a guess is the one thing this must not do.
    /// </summary>
    private async Task<IEnumerable<RedisKey>> FindRemovedStepsAsync(
        IDatabase db, string workflowKey, List<StepL1> next, CancellationToken ct)
    {
        var previous = ReadStore(await db.HashGetAsync(workflowKey, L2ProjectionKeys.StoreField).ConfigureAwait(false));
        if (previous?.Steps is not { Count: > 0 } previousSteps)
        {
            return [];
        }

        var current = next.Select(s => s.StepId).ToHashSet();
        var dropped = previousSteps.Select(s => s.StepId).Where(id => !current.Contains(id)).Distinct().ToList();
        if (dropped.Count == 0)
        {
            return [];
        }

        var existing = await _stepRows.ExistingAsync(dropped, ct).ConfigureAwait(false);
        return dropped.Where(id => !existing.Contains(id)).Select(id => (RedisKey)L2ProjectionKeys.StepEntity(id));
    }

    private static WorkflowStoreProjection? ReadStore(RedisValue json)
    {
        if (json.IsNullOrEmpty)
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<WorkflowStoreProjection>(json.ToString(), MessagingJson.Options);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// The cache keys the previous start of this workflow wrote that this start does not: every key of
    /// a root no longer bound, and every item no longer in a root that still is. Read before anything is
    /// written, from what the previous start recorded (each root's key set, or the JSON list of a start
    /// before the set existed). A root or list that is missing or unreadable
    /// contributes nothing — its keys are already unreachable, and aborting would strand the rest.
    /// </summary>
    private static async Task<List<RedisKey>> FindOwnLeftoversAsync(
        IDatabase db, Guid workflowId, string workflowKey, List<CacheL1> next)
    {
        var stale = new List<RedisKey>();
        var nextByRoot = next.ToDictionary(c => c.Root, c => c.Items ?? new Dictionary<string, string>(), StringComparer.Ordinal);

        var previousRoots = ReadList(await db.HashGetAsync(workflowKey, L2ProjectionKeys.RootsField).ConfigureAwait(false));

        foreach (var root in previousRoots.Where(r => !string.IsNullOrWhiteSpace(r)).Distinct(StringComparer.Ordinal))
        {
            var rootKey = L2ProjectionKeys.Cache(workflowId, root);
            var previousKeys = (await ReadKeyNamesAsync(db, workflowId, root).ConfigureAwait(false))
                .Where(k => !string.IsNullOrEmpty(k))
                .Distinct(StringComparer.Ordinal);

            if (!nextByRoot.TryGetValue(root, out var items))
            {
                stale.Add(rootKey);
                stale.Add(L2ProjectionKeys.CacheKeySet(workflowId, root));
                stale.AddRange(previousKeys.Select(k => (RedisKey)L2ProjectionKeys.CacheEntry(workflowId, root, k)));
                continue;
            }

            stale.Add(L2ProjectionKeys.CacheKeySet(workflowId, root));
            stale.AddRange(previousKeys
                .Where(k => !items.ContainsKey(k))
                .Select(k => (RedisKey)L2ProjectionKeys.CacheEntry(workflowId, root, k)));
        }

        return stale;
    }

    private static List<string> ReadList(RedisValue json)
    {
        if (json.IsNullOrEmpty)
        {
            return new List<string>();
        }

        try
        {
            return JsonSerializer.Deserialize<List<string>>(json.ToString(), MessagingJson.Options) ?? new List<string>();
        }
        catch (JsonException)
        {
            return new List<string>();
        }
    }
}
