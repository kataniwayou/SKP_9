namespace Processor.FileFetcher;

/// <summary>
/// The input contract: what the upstream importer's record carries. Bound with
/// <c>ProcessorConfig.SerializerOptions</c>, which is case-insensitive and ignores unknown
/// properties — so the org's <c>providerName</c> arrives, binds to nothing, and is dropped.
/// <para>
/// <b><c>location</c>, not <c>filePath</c>, because one shape serves two pairs</b> (2026-10-26). The
/// registered <c>locator</c> row is shared by this processor and ObjectFetcher, and by both
/// persisters' outputs: here it holds an absolute filesystem path, there an <c>s3://</c> URI. Which
/// one a location is decides which processor can open it, and this one says so by name rather than
/// guessing.
/// </para>
/// <para>
/// <b>providerName is deliberately absent from this record.</b> It is redundant: <c>location</c> is
/// absolute and complete. Adding it here would put it one edit away from the envelope, and the
/// design says it appears nowhere downstream.
/// </para>
/// </summary>
internal sealed record Locator(string? Location);
