using Microsoft.Extensions.Configuration;

namespace Processor.ObjectFetcher;

/// <summary>
/// The pod's own limit, bound from the <c>"ObjectFetcher"</c> config section and set in the manifest
/// as <c>ObjectFetcher__MaxObjectSizeBytes</c>.
/// <para>
/// <b>This is what the pod can survive; <see cref="ObjectFetcherConfig.MaximumSizeBytes"/> is what a
/// valid object for a feed looks like.</b> They are different questions and both are enforced: a step
/// payload naming more than this is a config error, reported by name rather than clamped. The whole
/// object is held in memory, so this is also the pod's memory sizing.
/// </para>
/// </summary>
public sealed class ObjectFetcherOptions
{
    /// <summary>Ceiling in bytes (default 32 MiB). The default lives here so an unset variable is
    /// never unbounded.</summary>
    [ConfigurationKeyName("MaxObjectSizeBytes")]
    public long MaxObjectSizeBytes { get; set; } = 33_554_432;
}
