using System.Text.Json;
using BaseConsole.Core.Naming;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;

namespace Orchestrator.L1;

/// <summary>
/// Reads workflows out of L2. The one place in the orchestrator that knows L2's key layout, and the
/// one place in the orchestrator that touches Redis at all.
/// <para>
/// <b>It reads, and it never writes.</b> The API is the sole writer of L2 (spec invariant 1); the
/// orchestrator is a consumer of the API's projections. Three operations appear here —
/// <c>SetMembersAsync</c> (the live set, for hydration), <c>SetContainsAsync</c> (the live guard on
/// both announcements) and <c>HashGetAsync</c> (a workflow's store, and each entity hash's
/// <c>name</c> field for log names) — and no fourth is permitted. A delete or a set here would let
/// this replica's view of the world become a fact about the world, which is precisely the inversion
/// the two invariants exist to prevent.
/// </para>
/// <para>
/// <b>A store that will not deserialize reads as absent, with a warning; a Redis fault propagates
/// untouched</b> (spec §7.4 RequeueAndTrip). The only catch sits around one Deserialize call.
/// </para>
/// </summary>
public sealed class L2WorkflowReader(IConnectionMultiplexer redis, ILogger<L2WorkflowReader> logger)
    : IEntityNameSource
{
    /// <summary>
    /// The name read this class makes: entity display names, for log records only, via
    /// <see cref="RedisEntityNameSource.ReadAsync"/>. UNLIKE the projection reads above, a fault here
    /// must not requeue a delivery or trip the gate. It propagates to <see cref="EntityNameResolver"/>,
    /// which catches it and logs the id suffix instead.
    /// </summary>
    public Task<IReadOnlyDictionary<Guid, string>> ReadNamesAsync(IReadOnlyCollection<EntityRef> refs) =>
        RedisEntityNameSource.ReadAsync(redis.GetDatabase(), refs);

    /// <summary>
    /// Every workflow id in the live set — exactly the workflows that are running; a stopped workflow's
    /// store stays in L2 but is not here. A member that is not a workflow id is skipped with a warning
    /// rather than failing the read: one unusable entry must not hide the rest of L2 from a hydration
    /// pass.
    /// </summary>
    public async Task<IReadOnlyList<Guid>> ReadAllIdsAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        var members = await redis.GetDatabase()
            .SetMembersAsync(L2ProjectionKeys.Live()).ConfigureAwait(false);

        var ids = new List<Guid>(members.Length);
        foreach (var member in members)
        {
            if (Guid.TryParseExact(member.ToString(), "D", out var id))
            {
                ids.Add(id);
            }
            else
            {
                // The member itself is not logged: it is whatever happens to be in the store, and this
                // service logs ids and outcomes only.
                logger.LogWarning("the live set holds a member that is not a workflow id; skipping it");
            }
        }

        return ids;
    }

    /// <summary>
    /// The workflow <paramref name="workflowId"/> as its last start stored it, or null when there is no
    /// usable store. Caches stay empty and names absent on purpose: nothing on the activation path reads
    /// them — processors address their cache keys directly, and names load through the resolver.
    /// </summary>
    public async Task<WorkflowL1?> ReadAsync(Guid workflowId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        // Outside ReadStore: a Redis fault must propagate, so no catch may sit near the read.
        var raw = await redis.GetDatabase()
            .HashGetAsync(L2ProjectionKeys.Workflow(workflowId), L2ProjectionKeys.StoreField).ConfigureAwait(false);

        if (raw.IsNullOrEmpty)
        {
            return null;
        }

        var store = ReadStore(raw);
        if (store is null)
        {
            logger.LogWarning("workflow {WorkflowId} holds a store that will not deserialize; treating it as absent", workflowId);
            return null;
        }

        return new WorkflowL1(
            workflowId, store.EntryStepIds ?? new List<Guid>(), store.Cron, store.Steps ?? new List<StepL1>(), new List<CacheL1>());
    }

    private static WorkflowStoreProjection? ReadStore(RedisValue raw)
    {
        try
        {
            return JsonSerializer.Deserialize<WorkflowStoreProjection>(raw.ToString(), MessagingJson.Options);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// Whether <paramref name="workflowId"/> is in the live set — the guard for both announcements. The
    /// store outlives a stop, so "the key exists" no longer says anything about whether it runs.
    /// </summary>
    public async Task<bool> IsLiveAsync(Guid workflowId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        return await redis.GetDatabase()
            .SetContainsAsync(L2ProjectionKeys.Live(), workflowId.ToString("D")).ConfigureAwait(false);
    }
}
