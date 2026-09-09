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
/// </param>
public sealed record FileReaderConfig(
    string ExpectedExtension,
    long MinimumSizeBytes,
    long MaximumSizeBytes) : ProcessorConfig;
