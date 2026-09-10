namespace Processor.ArchiveExpander;

/// <summary>
/// The input contract: what the upstream importer's record carries. Bound with
/// <c>ProcessorConfig.SerializerOptions</c>, which is case-insensitive and ignores unknown
/// properties — so the org's <c>providerName</c> arrives, binds to nothing, and is dropped.
/// <para>
/// <b>providerName is deliberately absent from this record.</b> It is redundant: <c>filePath</c> is
/// absolute and complete. Adding it here would put it one edit away from the output document, and
/// the design says it appears nowhere in the output.
/// </para>
/// </summary>
internal sealed record FileLocator(string? FilePath);
