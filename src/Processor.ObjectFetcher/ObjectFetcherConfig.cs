using BaseProcessor.Core.Configuration;

namespace Processor.ObjectFetcher;

/// <summary>
/// The step payload, identical in shape to FileFetcher's. Bound case-insensitively by
/// <see cref="ProcessorConfig.SerializerOptions"/>, which also ignores unknown properties.
/// <para>
/// <b>Everything here is knowable from a <c>HEAD</c>, and that is the rule for what belongs.</b> An
/// expectation that can only be checked after the object is downloaded saves nothing by living in
/// the payload — it belongs to the processor that downloads it.
/// </para>
/// </summary>
/// <param name="AllowedExtensions">
/// The whitelist. Each entry carries a leading dot and is compared case-insensitively, or is the
/// sentinel <c>"*.*"</c>. Absent, null or empty means <c>["*.*"]</c>; see
/// <see cref="ExtensionWhitelist.Resolve"/>.
/// </param>
/// <param name="MinimumSizeBytes">Floor, inclusive. Zero disables the check.</param>
/// <param name="MaximumSizeBytes">
/// Ceiling, inclusive, for the object. Admitted only if it fits inside the pod's own ceiling; see
/// <see cref="ObjectFetcherOptions"/>.
/// </param>
public sealed record ObjectFetcherConfig(
    long MinimumSizeBytes,
    long MaximumSizeBytes,
    // LAST, AND WITH A DEFAULT, for the reason FileFetcherConfig gives: the default is the signal
    // for optional that the startup conformance check reads.
    IReadOnlyList<string>? AllowedExtensions = null) : ProcessorConfig;
