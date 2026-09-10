namespace Processor.ArchiveExpander;

/// <summary>
/// The envelope as it ARRIVES: every field optional, because a malformed upstream record must be
/// diagnosed rather than thrown at. Bound with <c>ProcessorConfig.SerializerOptions</c>, which is
/// case-insensitive and ignores unknown properties.
/// <para>
/// <b>This is the reader's copy of <c>Processor.FileFetcher.FetchedFile</c>, whose fields are all
/// non-nullable.</b> The two describe one JSON document across two assemblies that must not
/// reference each other — the same arrangement, for the same reason, as
/// <c>ProcessorJsonSchemaValidator</c> duplicating <c>JsonSchemaConfig</c>. The registered envelope
/// schema pins the shape and <c>EnvelopeContractTests</c> is what catches a divergence.
/// </para>
/// <para>
/// <c>byte[]</c> needs no converter: System.Text.Json reads a base64 string straight into one.
/// </para>
/// </summary>
internal sealed record FetchedFile(
    string? FileName,
    string? Extension,
    long SizeBytes,
    DateTime? CreatedUtc,
    DateTime? ModifiedUtc,
    byte[]? Content);

/// <summary>
/// The envelope, checked. Nothing constructs this without having validated the wire form first,
/// which is why every field is non-nullable and <see cref="FileContentBuilder"/> takes this rather
/// than <see cref="FetchedFile"/>.
/// <para>
/// <b>Extension may be the empty string and that is legal</b> — a file with no dot in its name is
/// admitted upstream under the <c>*.*</c> whitelist, and <c>FileInfo.Extension</c> reports
/// <c>""</c> for it. Only the name and the content are required to be there at all.
/// </para>
/// </summary>
internal sealed record SourceFile(
    string Name,
    string Extension,
    byte[] Content,
    long SizeBytes,
    DateTime? CreatedUtc,
    DateTime? ModifiedUtc);
