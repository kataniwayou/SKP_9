using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging;
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
    private readonly ILogger<ProcessorLivenessWriter> _logger;

    public ProcessorLivenessWriter(
        IConnectionMultiplexer redis,
        ILogger<ProcessorLivenessWriter> logger)
    {
        _redis  = redis ?? throw new ArgumentNullException(nameof(redis));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>
    /// The key's lifetime: four times the interval the entry itself records.
    /// <para>
    /// Derived from the <b>entry's own</b> interval rather than live configuration, so each processor
    /// gets a TTL proportional to its own cadence and a slow one can never expire between its own
    /// writes. It also means a startup entry, which records the backoff anchor rather than the
    /// steady-state cadence, gets the longer lifetime its slower writes need.
    /// </para>
    /// <para>
    /// Four rather than two because the reader calls an entry stale at <c>interval x 2</c>. Expiring
    /// exactly then would collapse two distinct answers into one: a replica that registered and then
    /// wedged would vanish just as it became stale, and read as <c>absent</c> — indistinguishable
    /// from one deleted hours ago. The extra window is what keeps <c>stale</c> reportable, and it is
    /// deliberately proportional rather than a fixed floor, so the relationship holds at every
    /// configured cadence instead of only at the default one.
    /// </para>
    /// </summary>
    public static int DeriveTtlSeconds(int interval) => interval * 4;

    public async Task WriteAsync(Guid processorId, string instanceId, ProcessorLivenessEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        try
        {
            var db = _redis.GetDatabase();
            var ttl = TimeSpan.FromSeconds(DeriveTtlSeconds(entry.Interval));

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
