using System.Collections.Concurrent;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging;

namespace BaseConsole.Core.Naming;

/// <summary>
/// Resolves entity ids to display names for log records, from L2, once, held in memory.
/// <para>
/// <b>It never fails anything.</b> A missing key or an unreachable store yields the id's fallback
/// (<see cref="EntityNames.Fallback"/>). A read fault is caught HERE: it must never requeue a
/// delivery, fail a step or trip the gate the way a projection-read fault deliberately does.
/// </para>
/// <para>
/// <b>Hits are cached and misses never.</b> <see cref="ScopeAsync"/> and <see cref="PreloadAsync"/>
/// read only ids the cache lacks, so a processor keeps a name until its pod restarts (spec §5). A
/// miss is often a start still in flight, so it is re-read next time.
/// </para>
/// <para>
/// <b>The orchestrator refreshes at every activation.</b> Spec §6 freezes a workflow's and its steps'
/// names only until the workflow's next start, so <see cref="RefreshAsync"/> re-reads every id and
/// overwrites cached hits. A refresh that finds nothing or faults keeps the cached name: an old name
/// is better on a record than an id suffix.
/// </para>
/// </summary>
public sealed class EntityNameResolver(IEntityNameSource source, ILogger<EntityNameResolver> logger)
{
    // A stalled (not faulted) name store must not delay a delivery: the existing catch below turns a
    // TimeoutException from this cap into the same fallbacks it already gives an outright fault.
    private static readonly TimeSpan ReadTimeout = TimeSpan.FromMilliseconds(250);

    private readonly ConcurrentDictionary<Guid, string> _names = new();

    /// <summary>
    /// The names scope for a record about these ids, reading any that are not cached in one call.
    /// <see cref="Guid.Empty"/> means "no such entity on this record" and adds no attribute.
    /// </summary>
    public async Task<Dictionary<string, object>> ScopeAsync(Guid workflowId, Guid stepId, Guid processorId)
    {
        await LoadAsync(
        [
            new EntityRef(L2EntityKind.Workflow, workflowId),
            new EntityRef(L2EntityKind.Step, stepId),
            new EntityRef(L2EntityKind.Processor, processorId),
        ], refresh: false).ConfigureAwait(false);

        return CachedScope(workflowId, stepId, processorId);
    }

    /// <summary>
    /// Fills the cache ahead of use with the ids it does not yet hold. Never throws: a read that fails
    /// or times out leaves those ids to fall back, exactly as <see cref="ScopeAsync"/> does. The
    /// orchestrator uses <see cref="RefreshAsync"/> instead, so a restart also picks up renames.
    /// </summary>
    public Task PreloadAsync(IEnumerable<EntityRef> refs) => LoadAsync(refs, refresh: false);

    /// <summary>
    /// Re-reads every id, cached or not, and overwrites the cached names it finds — the orchestrator
    /// calls this at each activation so a rename shows from the workflow's next start (spec §6). A miss
    /// or a failed read keeps whatever name is cached. Never throws.
    /// </summary>
    public Task RefreshAsync(IEnumerable<EntityRef> refs) => LoadAsync(refs, refresh: true);

    private async Task LoadAsync(IEnumerable<EntityRef> refs, bool refresh)
    {
        var toRead = refs
            .Where(r => r.Id != Guid.Empty && (refresh || !_names.ContainsKey(r.Id)))
            .Distinct()
            .ToArray();

        if (toRead.Length == 0)
        {
            return;
        }

        try
        {
            var found = await source.ReadNamesAsync(toRead).WaitAsync(ReadTimeout).ConfigureAwait(false);
            foreach (var (id, name) in found)
            {
                // A source returning an empty name would otherwise cache an empty string forever;
                // treat it the same as a miss so the entity keeps re-resolving.
                if (!string.IsNullOrEmpty(name))
                {
                    _names[id] = name;
                }
            }
        }
        catch (Exception ex)
        {
            // Debug, not Warning: a store outage is already reported loudly by the gate, and a
            // line per delivery here would bury it. The records still carry the fallbacks.
            logger.LogDebug(ex, "entity names could not be read; logging the id suffix instead");
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
    public string NameOrFallback(Guid id) => _names.TryGetValue(id, out var name) ? name : EntityNames.Fallback(id);

    private void Put(Dictionary<string, object> scope, string key, Guid id)
    {
        if (id != Guid.Empty)
        {
            scope[key] = NameOrFallback(id);
        }
    }
}
