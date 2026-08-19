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

    /// <summary>Recorded <c>interval</c> on the startup loops' <c>unhealthy</c> entries (default 30,
    /// matching <see cref="BackoffCapSeconds"/>). Distinct from <see cref="IntervalSeconds"/> because
    /// those writes ride the retry backoff rather than a fixed cadence: at the cap the gap between
    /// two writes reaches <c>BackoffCap + RequestTimeout</c> = 38s, and recording 10 would derive a
    /// 30s TTL that expires between a replica's own writes — leaving it <c>absent</c> rather than
    /// <c>unhealthy</c>. Recording 30 derives <c>max(60, 30)</c> = 60s, which covers it.</summary>
    [ConfigurationKeyName("StartupInterval")]
    public int StartupIntervalSeconds { get; set; } = 30;

    /// <summary>Sliding liveness-key expiry floor in seconds (default 30). INDEPENDENT of
    /// <see cref="IntervalSeconds"/> — the TTL floor folded into the per-instance key
    /// via the writer's derived-TTL formula <c>max(interval×2, TtlSeconds)</c>.</summary>
    [ConfigurationKeyName("Ttl")]
    public int TtlSeconds { get; set; } = 30;

    /// <summary>Per-<c>IRequestClient</c> request timeout in seconds (default 8).</summary>
    [ConfigurationKeyName("RequestTimeout")]
    public int RequestTimeoutSeconds { get; set; } = 8;

    /// <summary>Retry backoff cap in seconds (default 30). The startup loops double their delay from
    /// one second up to this cap and retry forever — boot-before-register is tolerated, not an error.
    /// Also the number the startup loop's liveness window derives from
    /// (<c>BackoffCap × StaleFactor</c>), since a loop at the cap must not read as wedged.</summary>
    [ConfigurationKeyName("BackoffCap")]
    public int BackoffCapSeconds { get; set; } = 30;
}
