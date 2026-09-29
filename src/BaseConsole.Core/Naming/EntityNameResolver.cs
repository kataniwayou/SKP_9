using System.Collections.Concurrent;
using Messaging.Contracts;
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
/// <b>Hits are cached forever and misses never.</b> A name is fixed for an entity's life except
/// across a rename and restart, which is the accepted limit (a processor keeps the old name until
/// its pod restarts). A miss is often a start still in flight, so it is re-read next time.
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
        var unknown = new[] { workflowId, stepId, processorId }
            .Where(id => id != Guid.Empty && !_names.ContainsKey(id))
            .Distinct()
            .ToArray();

        if (unknown.Length > 0)
        {
            try
            {
                var found = await source.ReadNamesAsync(unknown).WaitAsync(ReadTimeout).ConfigureAwait(false);
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

        return CachedScope(workflowId, stepId, processorId);
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
