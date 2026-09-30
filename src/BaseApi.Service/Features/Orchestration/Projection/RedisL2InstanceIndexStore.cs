using Messaging.Contracts.Projections;
using StackExchange.Redis;

namespace BaseApi.Service.Features.Orchestration.Projection;

/// <summary>
/// Redis implementation of the instance-index store.
/// <para>
/// <b>Index keys are found by a narrowed scan pattern, backed by a type check.</b> The
/// <c>:instances</c> suffix on <see cref="L2ProjectionKeys.ProcessorInstances"/> already excludes the
/// processor's name hash and every per-instance key beneath it, so the pattern alone finds the right
/// keys. The type check stays so a stray non-set key under that suffix can never be reported as an
/// index. It also finds indexes belonging to processors that have since been deleted, which an
/// enumeration driven from the database would miss.
/// </para>
/// </summary>
internal sealed class RedisL2InstanceIndexStore : IL2InstanceIndexStore
{
    private readonly IConnectionMultiplexer _multiplexer;

    public RedisL2InstanceIndexStore(IConnectionMultiplexer multiplexer)
        => _multiplexer = multiplexer ?? throw new ArgumentNullException(nameof(multiplexer));

    public async Task<IReadOnlyList<string>> ListIndexKeysAsync(CancellationToken ct)
    {
        var db = _multiplexer.GetDatabase();
        var keys = new List<string>();

        foreach (var endpoint in _multiplexer.GetEndPoints())
        {
            var server = _multiplexer.GetServer(endpoint);
            if (!server.IsConnected || server.IsReplica)
            {
                continue;
            }

            foreach (var key in server.Keys(pattern: $"{L2ProjectionKeys.Prefix}proc:*:instances", pageSize: 250))
            {
                ct.ThrowIfCancellationRequested();

                // The pattern already excludes the name hash and the per-instance keys; the type check
                // stays so a stray non-set key under this suffix can never be reported as an index.
                if (await db.KeyTypeAsync(key).ConfigureAwait(false) is RedisType.Set)
                {
                    keys.Add(key!);
                }
            }
        }

        return keys;
    }

    public async Task<IReadOnlyList<string>> ListMembersAsync(string indexKey, CancellationToken ct)
    {
        var members = await _multiplexer.GetDatabase().SetMembersAsync(indexKey).ConfigureAwait(false);
        return members.Select(m => m.ToString()).ToList();
    }

    /// <summary>
    /// Removes the member only if its per-instance key is absent, as one conditional transaction.
    /// <para>
    /// <c>Condition.KeyNotExists</c> compiles to a watch on that key, so if the key reappears between
    /// the condition being registered and the transaction executing, the whole transaction is
    /// discarded and the membership stands. That is what makes this safe against a replica restarting
    /// mid-sweep: the writer sets the per-instance key before it re-adds the index member, so the key
    /// is always the earlier of the two to appear.
    /// </para>
    /// </summary>
    public async Task<bool> TryRemoveIfAbsentAsync(string indexKey, string instanceId, CancellationToken ct)
    {
        if (!L2ProjectionKeys.TryParseProcessorInstances(indexKey, out var processorId))
        {
            return false;   // not an instances key; nothing this sweeper may touch
        }

        var db = _multiplexer.GetDatabase();
        var perInstance = L2ProjectionKeys.PerInstance(processorId, instanceId);

        var tran = db.CreateTransaction();
        tran.AddCondition(Condition.KeyNotExists(perInstance));
        var removal = tran.SetRemoveAsync(indexKey, instanceId);

        if (!await tran.ExecuteAsync().ConfigureAwait(false))
        {
            return false;   // the key came back; the condition refused the transaction
        }

        return await removal.ConfigureAwait(false);
    }
}
