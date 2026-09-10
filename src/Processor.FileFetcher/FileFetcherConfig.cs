using BaseProcessor.Core.Configuration;

namespace Processor.FileFetcher;

/// <summary>
/// The step payload. Bound case-insensitively by <see cref="ProcessorConfig.SerializerOptions"/>,
/// which also ignores unknown properties so a field added later does not break workflows authored
/// before it.
/// <para>
/// <b>Everything here is knowable from <c>FileInfo</c>, and that is the rule for what belongs.</b>
/// An expectation that can only be checked after the file is opened saves nothing by living in the
/// payload — it belongs to the processor that opens it.
/// </para>
/// </summary>
/// <param name="AllowedExtensions">
/// The whitelist. Each entry carries a leading dot and is compared case-insensitively, or is the
/// sentinel <c>"*.*"</c>.
/// <para>
/// <b>Absent, null or empty means <c>["*.*"]</c></b> — see <see cref="ExtensionWhitelist.Resolve"/>
/// for why the default widens here and nowhere else.
/// </para>
/// <para>
/// <b>It ADMITS a file to the pipeline; it does not choose an extractor.</b> Nothing here knows what
/// an archive is. One hop downstream the declared extension is cross-checked against the file's
/// leading bytes, and this whitelist is the claim that check is made against.
/// </para>
/// </param>
/// <param name="MinimumSizeBytes">Floor, inclusive. Zero disables the check.</param>
/// <param name="MaximumSizeBytes">
/// Ceiling, inclusive, for <b>the file on disk</b> — and for nothing else. Admitted only if it fits
/// inside the pod's own ceiling; see <see cref="FileFetcherOptions"/>.
/// <para>
/// <b>It used to mean two things and now means one.</b> In FileReader this bounded both the file and
/// the cumulative size of everything an archive expanded to. The second meaning left with the
/// expansion, to <c>ArchiveExpander__MaxExpandedBytes</c> — a pod option, because the size of an
/// expansion is a number an operator sizes against a container limit and a workflow author has no
/// way to know.
/// </para>
/// </param>
public sealed record FileFetcherConfig(
    IReadOnlyList<string>? AllowedExtensions,
    long MinimumSizeBytes,
    long MaximumSizeBytes) : ProcessorConfig;
