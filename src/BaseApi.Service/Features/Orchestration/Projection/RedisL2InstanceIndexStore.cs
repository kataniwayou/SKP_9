using Messaging.Contracts.Projections;
using StackExchange.Redis;

namespace BaseApi.Service.Features.Orchestration.Projection;

/// <summary>
/// Redis implementation of the instance-index store.
/// <para>
/// <b>Index keys are discovered by type, not by parsing.</b> The <c>skp:proc:</c> prefix covers both
/// the per-processor index and the per-instance keys beneath it, and both halves of
/// <c>skp:proc:{processorId}:{instanceId}</c> can be split at a colon, so no pattern reliably tells
/// them apart. The index is a set and the per-instance key is a string, so scanning with a type
/// filter separates them exactly. It also finds indexes belonging to processors that have since been
/// deleted, which an enumeration driven from the database would miss.
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

            foreach (var key in server.Keys(pattern: $"{L2ProjectionKeys.Prefix}proc:*", pageSize: 250))
            {
                ct.ThrowIfCancellationRequested();

                // The scan pattern also matches the per-instance keys beneath each index. Filtering
                // here rather than at use keeps the returned list a true list of indexes, which is
                // what the caller counts when it reports how many processors it swept.
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
        var db = _multiplexer.GetDatabase();
        var perInstance = $"{indexKey}:{instanceId}";

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
