using Microsoft.Extensions.Configuration;

namespace Processor.ArchiveExpander;

/// <summary>
/// The pod's own limit, bound from the <c>"ArchiveExpander"</c> config section and set in the manifest as
/// <c>ArchiveExpander__MaxFileSizeBytes</c>.
/// <para>
/// <b>This is what the pod can survive; <see cref="ArchiveExpanderConfig.MaximumSizeBytes"/> is what a
/// valid file for a feed looks like.</b> They are different questions and both are enforced: a step
/// payload naming more than this is a config error, reported by name rather than clamped.
/// </para>
/// <para>
/// <b>It is a manifest value because a file does not cost its own size in flight.</b> The raw file
/// <c>byte[]</c>, the serialized UTF-8 document at ~1.33x the file, the broker message body at
/// ~1.78x (the document base64'd again inside the <c>ProcessedData</c> envelope) and a full
/// JsonDocument DOM at validation can coexist — and the work and post consumers are the SAME
/// process, so a dispatch and a branch overlap. Tuning that against a container's memory limit is an
/// operator's job per environment, not a constant's.
/// </para>
/// </summary>
public sealed class ArchiveExpanderOptions
{
    /// <summary>Ceiling in bytes (default 32 MiB). The default lives here so an unset variable is
    /// never unbounded.</summary>
    [ConfigurationKeyName("MaxFileSizeBytes")]
    public long MaxFileSizeBytes { get; set; } = 33_554_432;
}
