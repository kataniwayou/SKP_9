using BaseProcessor.Core.Configuration;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

namespace BaseProcessor.Core.Liveness;

/// <summary>
/// Writes the per-instance liveness key and keeps the instance index current.
/// <para>
/// A Redis fault is logged and swallowed. The caller is a loop whose next iteration will write
/// again, and a write failure must never end it.
/// </para>
/// </summary>
public sealed class ProcessorLivenessWriter
{
    private readonly IConnectionMultiplexer _redis;
    private readonly ProcessorLivenessOptions _options;
    private readonly ILogger<ProcessorLivenessWriter> _logger;

    public ProcessorLivenessWriter(
        IConnectionMultiplexer redis,
        IOptions<ProcessorLivenessOptions> options,
        ILogger<ProcessorLivenessWriter> logger)
    {
        _redis   = redis ?? throw new ArgumentNullException(nameof(redis));
        _options = options?.Value ?? throw new ArgumentNullException(nameof(options));
        _logger  = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>TTL is twice the recorded interval, floored — a slow cadence must not expire itself.</summary>
    public static int DeriveTtlSeconds(int interval, int floor) => Math.Max(interval * 2, floor);

    public async Task WriteAsync(Guid processorId, string instanceId, ProcessorLivenessEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        try
        {
            var db = _redis.GetDatabase();
            var ttl = TimeSpan.FromSeconds(DeriveTtlSeconds(entry.Interval, _options.TtlSeconds));

            await db.StringSetAsync(
                L2ProjectionKeys.PerInstance(processorId, instanceId),
                System.Text.Json.JsonSerializer.Serialize(entry),
                ttl).ConfigureAwait(false);

            await db.SetAddAsync(
                L2ProjectionKeys.InstanceIndex(processorId), instanceId).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "liveness write failed for {ProcessorId}/{InstanceId}", processorId, instanceId);
        }
    }
}
