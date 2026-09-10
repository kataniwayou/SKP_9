using System.Text.Json;
using System.Text.Json.Serialization;

namespace Processor.ArchiveCollapser;

/// <summary>
/// The envelope as it LEAVES -- every field non-nullable but the two timestamps, because nothing
/// constructs this without having read a valid document first.
/// <para>
/// <b>This is the writer's copy of <c>Processor.FileFetcher.FetchedFile</c>.</b> One JSON document
/// across assemblies that must not reference each other; <c>EnvelopeContractTests</c> catches a
/// divergence.
/// </para>
/// <para>
/// <b><c>SizeBytes</c> is the length of the archive actually produced</b>, never anything the input
/// document declared. The root's own <c>sizeBytes</c> is decoration and loses to the content, for
/// the same reason <c>entryCount</c> does: a wrong number in the input must not be able to
/// propagate into the output as if it were a fact.
/// </para>
/// <para>
/// <c>byte[]</c> needs no converter: System.Text.Json renders it as a base64 string, which is
/// exactly the wire form the envelope schema declares.
/// </para>
/// </summary>
internal sealed record CollapsedFile(
    string FileName,
    string Extension,
    long SizeBytes,
    DateTime? CreatedUtc,
    DateTime? ModifiedUtc,
    byte[] Content);

/// <summary>The one serializer configuration for the envelope.</summary>
internal static class CollapsedFileJson
{
    /// <summary>
    /// <b>camelCase, pinned explicitly.</b> <c>MessagingJson</c> leaves the naming policy null --
    /// PascalCase -- and it governs the <c>ProcessedData</c> envelope, not the bytes inside
    /// <c>Data</c>. Inheriting it here would silently rename every property the schema names.
    /// <para>
    /// <c>Never</c> ignore, and it is load-bearing: the envelope schema requires every key to be
    /// present, so a null timestamp must be emitted as <c>null</c> rather than omitted.
    /// </para>
    /// </summary>
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };
}
