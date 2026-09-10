using Microsoft.Extensions.Configuration;

namespace Processor.ArchiveExpander;

/// <summary>
/// The pod's expansion ceiling, bound from the <c>"ArchiveExpander"</c> config section and set in the
/// manifest as <c>ArchiveExpander__MaxExpandedBytes</c>.
/// <para>
/// <b>It bounds the cumulative size of everything an archive expands to, across every level</b> —
/// not the file, which <c>FileFetcher__MaxFileSizeBytes</c> already bounded one hop upstream. The
/// two are different quantities: an ordinary 10:1 CSV zip admitted at a 32 MiB file ceiling is
/// ~320 MB expanded before the document and the envelope are counted.
/// </para>
/// <para>
/// <b>It is an option rather than a step field because it is a memory guard, not a workflow
/// rule.</b> An operator sizes it against this container's limit; a workflow author has no way to
/// know what a given archive expands to, and asking them for the number was always asking them to
/// guess. In FileReader this lived on the step payload as the second meaning of
/// <c>MaximumSizeBytes</c>, and that field always had two owners.
/// </para>
/// <para>
/// <b>The default is FileReader's own, so the split changes no behaviour.</b> A workflow that
/// previously named 33554432 gets the same ceiling without naming anything.
/// </para>
/// </summary>
public sealed class ArchiveExpanderOptions
{
    /// <summary>Ceiling in bytes (default 32 MiB). The default lives here so an unset variable is
    /// never unbounded.</summary>
    [ConfigurationKeyName("MaxExpandedBytes")]
    public long MaxExpandedBytes { get; set; } = 33_554_432;
}
