using System.Text.Json;
using System.Text.Json.Serialization;

namespace Processor.FileFetcher;

/// <summary>
/// What crosses the hop: the file's identity and its content, in one document.
/// <para>
/// <b>The identity travels because the file is the only place it exists.</b> Name, extension and
/// timestamps are <c>FileInfo</c> facts, and this is the last processor that holds a
/// <c>FileInfo</c>. ArchiveExpander's output schema requires all of them on its root metadata node,
/// and a downstream step wants the filename for its own metadata — so this processor writes down
/// what it saw before letting go.
/// </para>
/// <para>
/// <b>No path, and that is a rule rather than an omission.</b> The path is a location whoever
/// authored the workflow chose; it appears nowhere in the output document, and carrying it here
/// would put it one edit away from doing so.
/// </para>
/// <para>
/// <b>Every field is non-nullable because this is the WRITER's view.</b> ArchiveExpander declares
/// its own reader's copy with every field optional, because a malformed upstream record must be
/// diagnosed rather than thrown at. The two records describe one JSON document and must stay in
/// sync; the registered envelope schema is what pins them, and <c>EnvelopeContractTests</c> is what
/// enforces it.
/// </para>
/// </summary>
/// <param name="SizeBytes">
/// <c>FileInfo.Length</c>, not <c>Content.Length</c>. For a whole file they agree, and the former is
/// the number the dry inspection already reported to an operator.
/// </param>
internal sealed record FetchedFile(
    string FileName,
    string Extension,
    long SizeBytes,
    DateTime? CreatedUtc,
    DateTime? ModifiedUtc,
    byte[] Content);

/// <summary>The one serializer configuration for the envelope.</summary>
internal static class FetchedFileJson
{
    /// <summary>
    /// <b>camelCase, pinned explicitly.</b> <c>MessagingJson</c> leaves the naming policy null —
    /// PascalCase — and it governs the <c>ProcessedData</c> envelope, not the bytes inside
    /// <c>Data</c>. Inheriting its convention here would silently rename every property the output
    /// schema names.
    /// <para>
    /// <c>Never</c> ignore, and it is load-bearing: the schema requires every key to be present, so
    /// a null timestamp must be emitted as <c>null</c> rather than omitted.
    /// </para>
    /// <para>
    /// <c>byte[]</c> needs no converter — System.Text.Json renders it as a base64 string and reads
    /// one back, which is exactly the wire form the schema declares.
    /// </para>
    /// </summary>
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };
}
