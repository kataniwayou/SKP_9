using BaseProcessor.Core.Configuration;

namespace Processor.FileReader;

/// <summary>
/// The step payload. Flat and scalar, bound case-insensitively by
/// <see cref="ProcessorConfig.SerializerOptions"/>, which also ignores unknown properties so a field
/// added later does not break workflows authored before it.
/// <para>
/// <b>There is no ExpectedEntryCount here, and that is a decision.</b> Entry count is the one
/// expectation only knowable AFTER the archive is opened, so checking it in the payload saves
/// nothing; it lives in the output schema instead. Extension and size are knowable from
/// <c>FileInfo</c>, and checking them here is what stops the file being read at all.
/// </para>
/// </summary>
/// <param name="ExpectedExtension">Leading dot, compared case-insensitively — <c>".zip"</c>.</param>
/// <param name="MinimumSizeBytes">Floor, inclusive. Zero disables the check.</param>
/// <param name="MaximumSizeBytes">
/// Ceiling, inclusive, for THIS step. Admitted only if it fits inside the pod's own ceiling — see
/// <see cref="FileReaderOptions"/>.
/// <para>
/// <b>IT BOUNDS TWO THINGS, NOT ONE: the file on disk AND, for an archive, the cumulative size of
/// everything it expands to.</b> A deliberate semantic change, made because the design's memory
/// budget (§6, and the limit in <c>k8s/37-processor-filereader.yaml</c>) prices the transient cost at
/// ~1.78x <i>the file</i> — correct for a leaf, and wrong for an archive, where the document is
/// ~1.33x the <i>expanded</i> content. An ordinary 10:1 CSV zip admitted at a 32 MiB file ceiling is
/// ~320 MB expanded before the document and the envelope are counted.
/// </para>
/// <para>
/// <b>No second field, and that is the ruling rather than an oversight.</b> A separate expansion
/// ceiling would be one more number a workflow author has to get right, and its only honest default
/// is this one. So a step that must admit a highly compressible archive raises this value, within
/// whatever the pod ceiling allows — the same knob, now meaning "the most this step will hold in
/// memory at once" rather than "the biggest file this step will open".
/// </para>
/// <para>
/// A file that expands past it fails with the <c>extracting {FilePath} failed:</c> template naming
/// both the expanded total and this ceiling, and NOT with the <c>rejected</c> template — the file
/// itself broke no rule, and an operator searching for a size rejection would not find a fault that
/// only exists once the archive was opened.
/// </para>
/// </param>
public sealed record FileReaderConfig(
    string ExpectedExtension,
    long MinimumSizeBytes,
    long MaximumSizeBytes) : ProcessorConfig;
