using Messaging.Contracts.Projections;
using StackExchange.Redis;

namespace BaseConsole.Core.Naming;

/// <summary>The processors' name source: one MGET over the name keys.</summary>
public sealed class RedisEntityNameSource(IConnectionMultiplexer redis) : IEntityNameSource
{
    public Task<IReadOnlyDictionary<Guid, string>> ReadNamesAsync(IReadOnlyCollection<Guid> ids) =>
        ReadAsync(redis.GetDatabase(), ids);

    /// <summary>
    /// The read itself, shared with the orchestrator's <c>L2WorkflowReader</c> so the two sources
    /// cannot read names differently.
    /// </summary>
    public static async Task<IReadOnlyDictionary<Guid, string>> ReadAsync(IDatabaseAsync db, IReadOnlyCollection<Guid> ids)
    {
        var list = ids.ToArray();
        var values = await db.StringGetAsync(list.Select(id => (RedisKey)L2ProjectionKeys.Name(id)).ToArray())
            .ConfigureAwait(false);

        var found = new Dictionary<Guid, string>(list.Length);
        for (var i = 0; i < list.Length; i++)
        {
            if (!values[i].IsNullOrEmpty)
            {
                found[list[i]] = values[i].ToString();
            }
        }

        return found;
    }
}
