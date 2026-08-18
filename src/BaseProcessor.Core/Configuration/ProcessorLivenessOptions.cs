using Microsoft.Extensions.Configuration;

namespace BaseProcessor.Core.Configuration;

/// <summary>
/// The processor liveness/heartbeat configuration, bound from the <c>"Processor"</c> config section.
/// </summary>
public sealed class ProcessorLivenessOptions
{
    /// <summary>Heartbeat delay in seconds (default 10). Written as the L2 <c>interval</c>
    /// field on heartbeat entries.</summary>
    [ConfigurationKeyName("Interval")]
    public int IntervalSeconds { get; set; } = 10;

    /// <summary>Sliding liveness-key expiry floor in seconds (default 30). INDEPENDENT of
    /// <see cref="IntervalSeconds"/> — the TTL floor folded into the per-instance key
    /// via the writer's derived-TTL formula <c>max(interval×2, TtlSeconds)</c>.</summary>
    [ConfigurationKeyName("Ttl")]
    public int TtlSeconds { get; set; } = 30;

    /// <summary>Per-<c>IRequestClient</c> request timeout in seconds (default 8).</summary>
    [ConfigurationKeyName("RequestTimeout")]
    public int RequestTimeoutSeconds { get; set; } = 8;
}
