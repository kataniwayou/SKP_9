using Messaging.Contracts.Projections;
using StackExchange.Redis;

namespace BaseConsole.Core.Naming;

public sealed class RedisEntityNameSource(IConnectionMultiplexer redis) : IEntityNameSource
{
    public Task<IReadOnlyDictionary<Guid, string>> ReadNamesAsync(IReadOnlyCollection<EntityRef> refs) =>
        ReadAsync(redis.GetDatabase(), refs);

    /// <summary>
    /// One HGET per reference, all issued before any is awaited, so the cost is one round trip. There is
    /// no multi-key hash read, and the keys span slots anyway.
    /// </summary>
    public static async Task<IReadOnlyDictionary<Guid, string>> ReadAsync(IDatabaseAsync db, IReadOnlyCollection<EntityRef> refs)
    {
        var list = refs.ToArray();
        var reads = new Task<RedisValue>[list.Length];
        for (var i = 0; i < list.Length; i++)
        {
            reads[i] = db.HashGetAsync(L2ProjectionKeys.Entity(list[i].Kind, list[i].Id), L2ProjectionKeys.NameField);
        }

        var values = await Task.WhenAll(reads).ConfigureAwait(false);

        var found = new Dictionary<Guid, string>(list.Length);
        for (var i = 0; i < list.Length; i++)
        {
            if (!values[i].IsNullOrEmpty)
            {
                found[list[i].Id] = values[i].ToString();
            }
        }

        return found;
    }
}
