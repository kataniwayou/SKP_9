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
        stale.AddRange(await FindRemovedStepsAsync(db, workflowId, workflowKey, steps, ct).ConfigureAwait(false));

        var store = new WorkflowStoreProjection(workflow.EntryStepIds ?? new List<Guid>(), workflow.Cron, steps);

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

        // Each step's role in THIS workflow, beside the graph it was computed from, so one start
        // writes both. See StepRoleClassifier and StepRoles.
        foreach (var (stepId, role) in StepRoleClassifier.Classify(store.EntryStepIds, steps))
        {
            writes.Add(batch.HashSetAsync(
                L2ProjectionKeys.StepRole(workflowId, stepId), L2ProjectionKeys.RoleField, role));
        }

        foreach (var cache in caches)
        {
            var items = cache.Items ?? new Dictionary<string, string>();

            // The key list goes at the cache root, so the next start can find the entries it has to
            // delete without a scan, and an operator reading one key sees the dictionary by name.
            writes.Add(batch.StringSetAsync(
                L2ProjectionKeys.Cache(workflowId, cache.Root),
                JsonSerializer.Serialize(items.Keys.ToList(), MessagingJson.Options)));

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
    /// The step name keys of steps this workflow dropped since its previous start and the database no
    /// longer holds. Only the dropped steps are looked up — kept and added steps are participants, so
    /// they exist by definition — and a start that dropped nothing makes no database read. A previous
    /// store that is missing or unreadable contributes nothing: without it there is no record of what
    /// was dropped, and deleting on a guess is the one thing this must not do.
    /// </summary>
    private async Task<IEnumerable<RedisKey>> FindRemovedStepsAsync(
        IDatabase db, Guid workflowId, string workflowKey, List<StepL1> next, CancellationToken ct)
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

        // The role key belongs to this workflow alone, so a dropped step loses it unconditionally. The
        // shared name key keeps its own rule: deleted only when no step row remains.
        var roleKeys = dropped.Select(id => (RedisKey)L2ProjectionKeys.StepRole(workflowId, id));

        var existing = await _stepRows.ExistingAsync(dropped, ct).ConfigureAwait(false);
        return dropped.Where(id => !existing.Contains(id))
            .Select(id => (RedisKey)L2ProjectionKeys.StepEntity(id))
            .Concat(roleKeys);
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
    /// written, from what the previous start recorded. A root or list that is missing or unreadable
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
            var previousKeys = ReadList(await db.StringGetAsync(rootKey).ConfigureAwait(false))
                .Where(k => !string.IsNullOrEmpty(k))
                .Distinct(StringComparer.Ordinal);

            if (!nextByRoot.TryGetValue(root, out var items))
            {
                stale.Add(rootKey);
                stale.AddRange(previousKeys.Select(k => (RedisKey)L2ProjectionKeys.CacheEntry(workflowId, root, k)));
                continue;
            }

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
