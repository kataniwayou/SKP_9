using Messaging.Contracts;
using Messaging.Transport;

namespace BaseApi.Service.Features.Cache;

/// <summary>
/// Sends the control messages that carry a cache's change to the running workflows' L2: the keys an append
/// or remove touched (<see cref="SendKeysAsync"/>, in chunks so a message stays small however large the
/// batch) or the whole dictionary (<see cref="SendFullAsync"/>, for a replace).
/// <para>
/// A send that fails sets <c>ex.Data["brokerOp"]</c> to a stable operation name and rethrows; callers send
/// only after their database commit, so the same request sent again re-sends (the refresh applies an end state).
/// </para>
/// </summary>
public sealed class CacheRefreshSender(IQueueSender sender)
{
    /// <summary>One <see cref="RefreshCacheItems"/> per <see cref="CacheRules.RefreshChunk"/> keys, in order, on the control queue.</summary>
    public async Task SendKeysAsync(Guid cacheId, IReadOnlyCollection<string> keys, CancellationToken ct)
    {
        try
        {
            foreach (var chunk in keys.Chunk(CacheRules.RefreshChunk))
                await sender.SendAsync(OrchestratorQueues.Control, MessageTypes.RefreshCacheItems,
                    new RefreshCacheItems(cacheId, [.. chunk]), ct);
        }
        catch (Exception ex)
        {
            ex.Data["brokerOp"] = "SendRefreshCacheItems";
            throw;
        }
    }

    /// <summary>One <see cref="RefreshCache"/>: the consumer re-reads the whole dictionary.</summary>
    public async Task SendFullAsync(Guid cacheId, CancellationToken ct)
    {
        try
        {
            await sender.SendAsync(OrchestratorQueues.Control, MessageTypes.RefreshCache, new RefreshCache(cacheId), ct);
        }
        catch (Exception ex)
        {
            ex.Data["brokerOp"] = "SendRefreshCache";
            throw;
        }
    }
}
