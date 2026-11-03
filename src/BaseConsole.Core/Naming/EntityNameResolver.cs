using System.Collections.Concurrent;
using BaseConsole.Core.Gating;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging;

namespace BaseConsole.Core.Naming;

/// <summary>
/// Resolves entity ids to display names for log records, from L2, held in memory for
/// <see cref="Ttl"/>.
/// <para>
/// <b>It never fails anything.</b> A missing key or an unreachable store yields the id's fallback
/// (<see cref="EntityNames.Fallback"/>). A read fault is caught HERE: it must never requeue a
/// delivery, fail a step or trip the gate the way a projection-read fault deliberately does.
/// </para>
/// <para>
/// <b>L2 first, the memory as its fallback (2026-11-03).</b> <see cref="ScopeAsync"/> reads from the
/// store every id it does not hold or last read more than <see cref="Ttl"/> ago, and overwrites the
/// cached names it finds. A step renamed and its workflow restarted therefore shows its new name
/// within <see cref="Ttl"/>, not after the processor's pod restarts (the limit spec §4 had
/// accepted), and the store is read about once per entity per <see cref="Ttl"/>, not once per
/// delivery: a store that is slow but up can delay a delivery by <see cref="ReadTimeout"/> at most
/// once per window.
/// </para>
/// <para>
/// <b>With the gate closed the store is not read at all.</b> It is known to be down, so a scope
/// takes the cached name, or the fallback, without waiting out <see cref="ReadTimeout"/>, however old
/// the cached name is. With the gate open, a read that finds nothing or faults keeps the cached name
/// and restarts its window, so a faulting store is not asked again on every delivery. Misses are
/// never cached: a miss is often a start still in flight, so it is re-read next time. A resolver with
/// no gate (a host or test that wires none) treats the store as up.
/// </para>
/// <para>
/// <b>The orchestrator refreshes at every activation.</b> Spec §6 freezes a workflow's and its steps'
/// names only until the workflow's next start, so <see cref="RefreshAsync"/> re-reads every id,
/// however fresh, and overwrites cached hits. A refresh that finds nothing or faults keeps the cached
/// name: an old name is better on a record than an id suffix.
/// </para>
/// </summary>
public sealed class EntityNameResolver(
    IEntityNameSource source, ILogger<EntityNameResolver> logger, L2Gate? gate = null, TimeProvider? clock = null)
{
    /// <summary>How long a name read from the store is used before it is read again (2026-11-03).</summary>
    public static readonly TimeSpan Ttl = TimeSpan.FromSeconds(30);

    // A stalled (not faulted) name store must not delay a delivery: the existing catch below turns a
    // TimeoutException from this cap into the same fallbacks it already gives an outright fault.
    private static readonly TimeSpan ReadTimeout = TimeSpan.FromMilliseconds(250);

    private readonly TimeProvider _clock = clock ?? TimeProvider.System;

    private readonly ConcurrentDictionary<Guid, Entry> _names = new();

    private readonly record struct Entry(string Name, DateTimeOffset ReadAt);

    private enum Reads { Missing, Stale, All }

    /// <summary>
    /// The names scope for a record about these ids, reading the ones not held or older than
    /// <see cref="Ttl"/> in one call; with the gate closed, from the cache alone.
    /// <see cref="Guid.Empty"/> means "no such entity on this record" and adds no attribute.
    /// </summary>
    public async Task<Dictionary<string, object>> ScopeAsync(Guid workflowId, Guid stepId, Guid processorId)
    {
        if (gate is null || gate.IsOpen)
        {
            await LoadAsync(
            [
                new EntityRef(L2EntityKind.Workflow, workflowId),
                new EntityRef(L2EntityKind.Step, stepId),
                new EntityRef(L2EntityKind.Processor, processorId),
            ], Reads.Stale).ConfigureAwait(false);
        }

        return CachedScope(workflowId, stepId, processorId);
    }

    /// <summary>
    /// Fills the cache ahead of use with the ids it does not yet hold. Never throws: a read that fails
    /// or times out leaves those ids to fall back. The orchestrator uses <see cref="RefreshAsync"/>
    /// instead, so a restart also picks up renames.
    /// </summary>
    public Task PreloadAsync(IEnumerable<EntityRef> refs) => LoadAsync(refs, Reads.Missing);

    /// <summary>
    /// Re-reads every id, cached or not, and overwrites the cached names it finds — the orchestrator
    /// calls this at each activation so a rename shows from the workflow's next start (spec §6). A miss
    /// or a failed read keeps whatever name is cached. Never throws.
    /// </summary>
    public Task RefreshAsync(IEnumerable<EntityRef> refs) => LoadAsync(refs, Reads.All);

    private async Task LoadAsync(IEnumerable<EntityRef> refs, Reads reads)
    {
        var now = _clock.GetUtcNow();
        var toRead = refs
            .Where(r => r.Id != Guid.Empty && reads switch
            {
                Reads.Missing => !_names.ContainsKey(r.Id),
                Reads.Stale   => !_names.TryGetValue(r.Id, out var e) || now - e.ReadAt >= Ttl,
                _             => true,
            })
            .Distinct()
            .ToArray();

        if (toRead.Length == 0)
        {
            return;
        }

        IReadOnlyDictionary<Guid, string> found;
        try
        {
            found = await source.ReadNamesAsync(toRead).WaitAsync(ReadTimeout).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // Debug, not Warning: a store outage is already reported loudly by the gate, and a
            // line per delivery here would bury it. The records still carry the fallbacks.
            logger.LogDebug(ex, "entity names could not be read; logging the id suffix instead");
            found = new Dictionary<Guid, string>();
        }

        var readAt = _clock.GetUtcNow();
        foreach (var r in toRead)
        {
            // A source returning an empty name would otherwise cache an empty string forever;
            // treat it the same as a miss so the entity keeps re-resolving.
            if (found.TryGetValue(r.Id, out var name) && !string.IsNullOrEmpty(name))
            {
                _names[r.Id] = new Entry(name, readAt);
            }
            else if (_names.TryGetValue(r.Id, out var kept))
            {
                // found nothing or faulted: the cached name stays, asked again only after a full window
                _names[r.Id] = kept with { ReadAt = readAt };
            }
        }
    }

    /// <summary>The same scope from the cache alone, for synchronous sites. It never reads the store.</summary>
    public Dictionary<string, object> CachedScope(Guid workflowId, Guid stepId, Guid processorId)
    {
        var scope = new Dictionary<string, object>(3);
        Put(scope, EntityNames.WorkflowName, workflowId);
        Put(scope, EntityNames.StepName, stepId);
        Put(scope, EntityNames.ProcessorName, processorId);
        return scope;
    }

    /// <summary>The cached name, or the fallback. It never reads the store.</summary>
    public string NameOrFallback(Guid id) => _names.TryGetValue(id, out var e) ? e.Name : EntityNames.Fallback(id);

    private void Put(Dictionary<string, object> scope, string key, Guid id)
    {
        if (id != Guid.Empty)
        {
            scope[key] = NameOrFallback(id);
        }
    }
}
