using System.Text.Json;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using StackExchange.Redis;

namespace BaseApi.Service.Features.Orchestration.Projection;

/// <summary>
/// Removes one workflow's projection: the root, every step key it recorded, every cache root it
/// recorded together with that dictionary's entries, and its entry in the parent index.
/// <para>
/// <b>Both the start and stop paths use this, and start needs it for a reason that is easy to
/// miss.</b> Start overwrites the keys its new definition names — but a definition that has lost
/// steps since the last start does not name the keys those steps used, so nothing overwrites them and
/// nothing deletes them. Worse, they are unreachable from the new root, so no later stop finds them
/// either: they leak permanently, one key per removed step per edit. Deleting the previous key set
/// before writing the new one is what keeps the stored graph equal to the definition rather than to
/// the union of every definition ever written.
/// </para>
/// <para>
/// <b>The key set is read from the root, not rediscovered by walking the graph.</b> The writer
/// records every key it wrote, so removal is one read and one batch instead of a read per step. It is
/// also exact where a walk is not: a walk that meets an already-missing step key cannot follow its
/// successors, so it strands every step beyond that point — the precise keys most in need of
/// collection are the ones a walk is least able to find.
/// </para>
/// <para>
/// <b>A cache dictionary's entries are named at its own root, not at the workflow root.</b> The
/// workflow root records only the list of cache roots; each root then has to be read for the list of
/// entry keys it names, one extra read per dictionary. That is the same reason the entry keys cannot
/// be recorded on the workflow root instead: a cache root is a flat leaf rather than a graph node, so
/// nothing upstream of it already knows its contents. A root that is already gone contributes no
/// entries, but it does not stop the rest of the removal — those entries are already unreachable, and
/// letting a missing root abort the batch would strand every key after it.
/// </para>
/// <para>
/// <b>This maintains an invariant rather than repairing one.</b> Because it runs before every write,
/// the stored key set always equals what the last root recorded. Skipping it even once produces
/// orphans that no later run can recover, because the record of them is what the next write
/// overwrites.
/// </para>
/// </summary>
internal sealed class L2Cleanup
{
    private readonly IConnectionMultiplexer _multiplexer;

    public L2Cleanup(IConnectionMultiplexer multiplexer)
        => _multiplexer = multiplexer ?? throw new ArgumentNullException(nameof(multiplexer));

    /// <summary>
    /// Deletes the stored projection for <paramref name="workflowId"/>. An absent root is a no-op:
    /// the desired end state already holds, which is what makes repeated calls safe.
    /// </summary>
    public async Task RemoveAsync(Guid workflowId, CancellationToken ct)
    {
        var db = _multiplexer.GetDatabase();

        // Removed first, and above the absent-root return, so an index entry left behind by an earlier
        // partial delete is cleaned up even when the data keys are already gone.
        await db.SetRemoveAsync(L2ProjectionKeys.ParentIndex(), workflowId.ToString("D"))
            .ConfigureAwait(false);

        var rootJson = await db.StringGetAsync(L2ProjectionKeys.Root(workflowId)).ConfigureAwait(false);
        if (rootJson.IsNullOrEmpty)
        {
            return;
        }

        var root = JsonSerializer.Deserialize<WorkflowRootProjection>(rootJson!, MessagingJson.Options);

        var stepKeys = (root?.StepIds ?? new List<Guid>())
            .Where(id => id != Guid.Empty)
            .Distinct()
            .Select(id => (RedisKey)L2ProjectionKeys.Step(workflowId, id))
            .ToArray();

        // Read the key list from each cache root, exactly as the step key set is read from the
        // workflow root: the write recorded what it wrote, so removal is one read per dictionary
        // rather than a scan. A cache root that is already gone contributes nothing — its entries
        // are unreachable, and aborting here would strand every key after it. The whitespace check is
        // defence-in-depth: CacheRules.CheckRoot rejects blank and whitespace roots and CacheEntity.Root
        // trims on assignment, so no writer can produce one — but this reads a root name back out of
        // stored JSON, which is exactly where an upstream guard should not be trusted blindly.
        var cacheKeys = new List<RedisKey>();

        foreach (var cacheRoot in (root?.CacheRoots ?? new List<string>()).Distinct(StringComparer.Ordinal))
        {
            if (string.IsNullOrWhiteSpace(cacheRoot))
            {
                continue;
            }

            var cacheRootKey = L2ProjectionKeys.Cache(workflowId, cacheRoot);
            cacheKeys.Add(cacheRootKey);

            var listJson = await db.StringGetAsync(cacheRootKey).ConfigureAwait(false);
            if (listJson.IsNullOrEmpty)
            {
                continue;
            }

            var keys = JsonSerializer.Deserialize<List<string>>(listJson!, MessagingJson.Options)
                       ?? new List<string>();

            cacheKeys.AddRange(keys
                .Where(k => !string.IsNullOrEmpty(k))
                .Distinct(StringComparer.Ordinal)
                .Select(k => (RedisKey)L2ProjectionKeys.CacheEntry(workflowId, cacheRoot, k)));
        }

        // One batch, so a failure part-way leaves either the whole graph or none of it rather than a
        // root pointing at steps that are already gone — which would be a graph nothing can walk.
        var batch = db.CreateBatch();
        var deletes = new List<Task> { batch.KeyDeleteAsync(L2ProjectionKeys.Root(workflowId)) };
        if (stepKeys.Length > 0)
        {
            deletes.Add(batch.KeyDeleteAsync(stepKeys));
        }

        if (cacheKeys.Count > 0)
        {
            deletes.Add(batch.KeyDeleteAsync(cacheKeys.ToArray()));
        }

        batch.Execute();
        await Task.WhenAll(deletes).ConfigureAwait(false);
    }
}
