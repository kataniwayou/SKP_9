using Microsoft.Extensions.Logging;

namespace BaseApi.Service.Features.Orchestration.Projection;

/// <summary>
/// Reclaims instance-index members whose per-instance liveness key has expired.
/// <para>
/// The liveness writer sets a per-instance key with a TTL and adds the instance id to a per-processor
/// index set. The key expires when a replica stops writing; the index membership does not, because a
/// set carries no per-member lifetime. The index therefore only grows, one dead member per pod that
/// ever ran.
/// </para>
/// <para>
/// <b>This does not change any gate verdict.</b> The liveness gate already counts an absent member
/// and skips it, admitting a processor on the first healthy replica it finds, so orphans have never
/// been able to fail a start. What they cost is unbounded memory on a key nothing prunes, a wasted
/// read per dead member on every gate evaluation, and a misleading "checked" count in the 422 a
/// genuinely dead processor produces.
/// </para>
/// <para>
/// <b>Deliberately a sweep rather than a step in the gate.</b> The gate short-circuits on the first
/// healthy replica, so pruning there could only ever reclaim the members it happened to read before
/// stopping — the dead members after that point are precisely the ones it would never reach. Running
/// the whole index on its own schedule reclaims all of them and keeps the work off the request path.
/// </para>
/// </summary>
internal sealed class L2OrphanSweeper
{
    private readonly IL2InstanceIndexStore _store;
    private readonly ILogger<L2OrphanSweeper> _logger;

    public L2OrphanSweeper(IL2InstanceIndexStore store, ILogger<L2OrphanSweeper> logger)
    {
        _store  = store  ?? throw new ArgumentNullException(nameof(store));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>
    /// Sweeps every index and returns how many members were reclaimed.
    /// <para>
    /// A fault on one index is logged and skipped rather than ending the pass. This is best-effort
    /// housekeeping on a background loop: one unreadable processor must not cost every processor after
    /// it in the iteration, and the next pass will retry it anyway.
    /// </para>
    /// </summary>
    public async Task<int> SweepAsync(CancellationToken ct)
    {
        var indexKeys = await _store.ListIndexKeysAsync(ct).ConfigureAwait(false);
        var reclaimed = 0;

        foreach (var indexKey in indexKeys)
        {
            ct.ThrowIfCancellationRequested();

            try
            {
                var members = await _store.ListMembersAsync(indexKey, ct).ConfigureAwait(false);

                foreach (var instanceId in members)
                {
                    // The condition is evaluated inside the removal, not here: a replica that
                    // re-registers between the listing above and this call keeps its membership.
                    if (await _store.TryRemoveIfAbsentAsync(indexKey, instanceId, ct).ConfigureAwait(false))
                    {
                        reclaimed++;
                    }
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogWarning(ex, "orphan sweep skipped index {IndexKey}", indexKey);
            }
        }

        if (reclaimed > 0)
        {
            _logger.LogInformation(
                "orphan sweep reclaimed {Reclaimed} instance-index members across {Indexes} processors",
                reclaimed, indexKeys.Count);
        }

        return reclaimed;
    }
}
