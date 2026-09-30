using System.Text.Json;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using StackExchange.Redis;

namespace BaseApi.Service.Features.Orchestration.Projection;

/// <summary>
/// Writes one workflow into L2 and aligns what that workflow owns: <c>skp:wf:{id}</c> (name, store,
/// roots), its cache dictionaries, and each of its steps' names.
/// <para>
/// <b>Overwrite, never clean.</b> The workflow hash and the step hashes are overwritten; the only keys
/// deleted are this workflow's own leftovers — cache roots it no longer binds and cache items the
/// database no longer holds — found from the <c>roots</c> field and each root's key list that the
/// previous start recorded. Step name keys are never deleted: a step can belong to other workflows.
/// </para>
/// <para>
/// <b>One batch.</b> The deletes are disjoint from the writes by construction, so their order inside
/// the batch is unobservable. A failure requeues the control message and the whole method runs again;
/// the previous state it reads back is still there, so the rerun computes the same leftovers.
/// </para>
/// </summary>
internal sealed class L2ProjectionWriter
{
    private readonly IConnectionMultiplexer _multiplexer;

    public L2ProjectionWriter(IConnectionMultiplexer multiplexer)
        => _multiplexer = multiplexer ?? throw new ArgumentNullException(nameof(multiplexer));

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

        var store = new WorkflowStoreProjection(workflow.EntryStepIds ?? new List<Guid>(), workflow.Cron, steps);

        var batch = db.CreateBatch();
        var writes = new List<Task>
        {
            batch.HashSetAsync(workflowKey,
            [
                new HashEntry(L2ProjectionKeys.StoreField, JsonSerializer.Serialize(store, MessagingJson.Options)),
                new HashEntry(L2ProjectionKeys.RootsField,
                    JsonSerializer.Serialize(caches.Select(c => c.Root).ToList(), MessagingJson.Options)),
            ]),
        };

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
        // own steps: an id that is neither has no key this start owns. Never deleted -- entities are
        // shared across workflows and records keep arriving after a stop.
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

        if (stale.Count > 0)
        {
            writes.Add(batch.KeyDeleteAsync(stale.ToArray()));
        }

        batch.Execute();
        await Task.WhenAll(writes).ConfigureAwait(false);
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
