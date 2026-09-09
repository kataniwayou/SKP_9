using System.Text.Json;
using System.Text.Json.Serialization;

namespace Processor.FileReader;

/// <summary>
/// File info, and nothing derived from the file's contents. <c>DateTime</c> rather than
/// <c>DateTimeOffset</c> so <c>System.Text.Json</c> renders a UTC instant as <c>...Z</c> rather than
/// <c>+00:00</c> — the shape the output schema documents.
/// </summary>
/// <param name="EntryCount">
/// How many entries the node holds. Derived from <see cref="FileNode.Entries"/> and present for a
/// reader's convenience — the SCHEMA constrains the array, never this, because a counting bug here
/// must not be able to satisfy a rule the content fails.
/// </param>
public sealed record FileMetadata(
    string Name,
    string Extension,
    long SizeBytes,
    DateTime? CreatedUtc,
    DateTime? ModifiedUtc,
    int EntryCount);

/// <summary>
/// One node of the document, and the shape is identical at every level so the schema is a single
/// self-referencing definition.
/// <para>
/// <b>A leaf carries <see cref="Content"/> and an empty <see cref="Entries"/>; an archive carries
/// null content and its expansion.</b> Carrying the archive's own bytes as well would double the
/// blob for no consumer.
/// </para>
/// <para>
/// <b>Depth is one.</b> A zip inside a zip is a leaf: recorded with its bytes and metadata, not
/// expanded. Recursion is the one dimension here with no natural bound.
/// </para>
/// </summary>
public sealed record FileNode(
    FileMetadata Metadata,
    byte[]? Content,
    IReadOnlyList<FileNode> Entries);

/// <summary>The one serializer configuration for the document.</summary>
internal static class FileDocument
{
    /// <summary>
    /// <b>camelCase, pinned explicitly.</b> <c>MessagingJson</c> leaves the naming policy null —
    /// PascalCase — and it governs the <c>ProcessedData</c> envelope, not the bytes inside
    /// <c>Data</c>. Inheriting its convention here would silently rename every property the output
    /// schema names.
    /// <para>
    /// <c>Never</c> ignore: <c>content</c> must be emitted as <c>null</c> on an archive rather than
    /// omitted, because the schema requires the key to be present.
    /// </para>
    /// </summary>
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };
}
