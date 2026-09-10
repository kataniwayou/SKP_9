using Microsoft.Extensions.Configuration;

namespace Processor.FileFetcher;

/// <summary>
/// The pod's own limit, bound from the <c>"FileFetcher"</c> config section and set in the manifest as
/// <c>FileFetcher__MaxFileSizeBytes</c>.
/// <para>
/// <b>This is what the pod can survive; <see cref="FileFetcherConfig.MaximumSizeBytes"/> is what a
/// valid file for a feed looks like.</b> They are different questions and both are enforced: a step
/// payload naming more than this is a config error, reported by name rather than clamped.
/// </para>
/// <para>
/// <b>It bounds the FILE, and nothing beyond it.</b> What an archive expands to is a different
/// quantity with a different owner, guarded by <c>ArchiveExpander__MaxExpandedBytes</c> one hop
/// downstream. This processor never opens a file, so it could not enforce that one if it wanted to.
/// </para>
/// </summary>
public sealed class FileFetcherOptions
{
    /// <summary>Ceiling in bytes (default 32 MiB). The default lives here so an unset variable is
    /// never unbounded.</summary>
    [ConfigurationKeyName("MaxFileSizeBytes")]
    public long MaxFileSizeBytes { get; set; } = 33_554_432;
}
