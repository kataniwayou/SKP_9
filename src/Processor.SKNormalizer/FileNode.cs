using System.Text.Json;
using System.Text.Json.Serialization;

namespace Processor.SKNormalizer;

/// <summary>
/// File info, and nothing derived from the file's contents. <c>DateTime</c> rather than
/// <c>DateTimeOffset</c> so <c>System.Text.Json</c> renders a UTC instant as <c>...Z</c> rather than
/// <c>+00:00</c> — the shape the schema documents.
/// </summary>
/// <param name="Name">The node's file name, including its extension.</param>
/// <param name="Extension">The node's extension, carried separately so a reader need not parse the name.</param>
/// <param name="SizeBytes">The node's size as measured upstream. Carried, never enforced here.</param>
/// <param name="CreatedUtc">Creation stamp from the source filesystem, or null when it had none.</param>
/// <param name="ModifiedUtc">Modification stamp from the source filesystem, or null when it had none.</param>
/// <param name="EntryCount">
/// How many entries the node holds. Derived from <see cref="FileNode.Content"/> and present for a
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
/// What a node holds: either the bytes of a file, or the nodes an archive expanded to. Never both.
/// <para>
/// <b>This is a union, and it replaces a pair of fields that could contradict each other.</b> The
/// node was <c>(Metadata, byte[]? Content, IReadOnlyList&lt;FileNode&gt; Entries)</c>, which encoded
/// the leaf/archive distinction TWICE — null content and empty entries — and nothing stopped a bug
/// from setting both or neither. A closed hierarchy makes the illegal states unrepresentable, and it
/// is why <c>content</c> is one key in the document rather than two.
/// </para>
/// <para>
/// C# has no union type, so this is the nearest thing the language offers: an abstract record with a
/// private constructor, which nothing outside this file can extend.
/// <see cref="FileNodeConverter"/> is what turns it into one JSON value.
/// </para>
/// </summary>
public abstract record FileContent
{
    // Private, so the two nested records below are the only cases that will ever exist. A third case
    // added later is a deliberate edit here, not an accident somewhere else.
    private FileContent()
    {
    }

    /// <summary>A file's own bytes. Rendered as a base64 string.</summary>
    public sealed record Bytes(byte[] Value) : FileContent;

    /// <summary>
    /// What an archive expanded to. Rendered as an array of nodes.
    /// <para>
    /// <b>An archive that expanded to nothing is null, not this holding an empty list</b> — see
    /// <see cref="FileNode.Content"/>.
    /// </para>
    /// </summary>
    public sealed record Entries(IReadOnlyList<FileNode> Value) : FileContent;
}

/// <summary>
/// One node of the document, and the shape is identical at every level so the schema is a single
/// self-referencing definition.
/// <para>
/// <b>This file is a deliberate duplicate of the same type in <c>Processor.ArchiveExpander</c> and
/// <c>Processor.ArchiveCollapser</c>.</b> Three assemblies that must not reference each other
/// describe one JSON document — the same arrangement, for the same reason, as <c>FetchedFile</c>
/// between FileFetcher and ArchiveExpander. This processor sits between the other two and both
/// reads and writes the document, so a divergence here breaks the chain in either direction.
/// <c>EnvelopeContractTests</c> is what catches one, by running all three real processors back to
/// back.
/// </para>
/// </summary>
/// <param name="Content">
/// The bytes, the expansion, or null.
/// <para>
/// <b>Null means the document records an archive that expanded to nothing, and this assembly
/// carries that through as null.</b> Nothing is packed here — ArchiveCollapser is what later turns
/// null into the format's canonical empty archive. <c>TreeAssembler</c> therefore emits null for a
/// container with no children AT EVERY DEPTH, including the root: writing an empty array instead
/// would change the representation the expander chose, and byte identity through this processor
/// would stop holding for any document containing a nested empty archive.
/// </para>
/// <para>
/// <b><see cref="FileContent.Bytes"/> is written back as a plain entry, whatever the node's extension
/// claims.</b> A node named <c>.zip</c> holding base64 is an archive ArchiveExpander already decided
/// not to open — a depth limit, an unrecognised format — and this assembly has no way to
/// second-guess that call and no need to: re-opening it here to re-pack it would be work the
/// document never asked for.
/// </para>
/// <para>
/// <b>An expanded archive never carries its own bytes as well.</b> The entries ARE its content, and
/// holding both would double the blob for no consumer.
/// </para>
/// </param>
/// <param name="Metadata">The node's own description: name, extension, size and stamps.</param>
public sealed record FileNode(FileMetadata Metadata, FileContent? Content);

/// <summary>
/// Maps <see cref="FileNode"/> to and from <c>{metadata, content}</c>, with <c>content</c> as a
/// base64 string, an array of nodes, or null.
/// <para>
/// <b>A hand-written converter rather than <c>[JsonDerivedType]</c>.</b> System.Text.Json's
/// polymorphic support emits a <c>$type</c> discriminator property, which would appear in the
/// document and have to be admitted by the schema — a serializer's implementation detail
/// leaking into a contract other systems read. Here the JSON value's own type IS the discriminator,
/// which is what makes the schema expressible as one <c>type: ["string", "array", "null"]</c>.
/// </para>
/// </summary>
public sealed class FileNodeConverter : JsonConverter<FileNode>
{
    private const string MetadataName = "metadata";
    private const string ContentName = "content";

    /// <summary>
    /// The inverse, and here it is a PRODUCTION path too: what this processor sends is a document
    /// of the same contract it received, so every dispatch serializes the tree the assembler built.
    /// Tests also use it to construct an input document.
    /// </summary>
    public override void Write(Utf8JsonWriter writer, FileNode value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();

        writer.WritePropertyName(MetadataName);
        JsonSerializer.Serialize(writer, value.Metadata, options);

        writer.WritePropertyName(ContentName);

        switch (value.Content)
        {
            case FileContent.Bytes bytes:
                // Encodes straight into the output buffer. There is no intermediate base64 string on
                // the heap, which is why the memory budget in the design does not carry one.
                writer.WriteBase64StringValue(bytes.Value);
                break;

            case FileContent.Entries entries:
                writer.WriteStartArray();
                foreach (var entry in entries.Value)
                {
                    Write(writer, entry, options);
                }

                writer.WriteEndArray();
                break;

            default:
                // Explicitly written, never omitted: the schema requires the key to be present.
                writer.WriteNullValue();
                break;
        }

        writer.WriteEndObject();
    }

    /// <summary>
    /// <b>The production path, and so is <c>Write</c>.</b> This processor is handed a document and
    /// emits a document of the same contract, so unlike either neighbour it needs both directions in
    /// production: ArchiveExpander only writes and ArchiveCollapser only reads.
    /// </summary>
    public override FileNode Read(
        ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.StartObject)
        {
            throw new JsonException("a file node must be an object");
        }

        FileMetadata? metadata = null;
        FileContent? content = null;

        while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
        {
            if (reader.TokenType != JsonTokenType.PropertyName)
            {
                throw new JsonException("expected a property name");
            }

            var name = reader.GetString();
            reader.Read();

            switch (name)
            {
                case MetadataName:
                    metadata = JsonSerializer.Deserialize<FileMetadata>(ref reader, options);
                    break;

                case ContentName:
                    content = ReadContent(ref reader, options);
                    break;

                default:
                    reader.Skip();
                    break;
            }
        }

        if (metadata is null)
        {
            throw new JsonException("a file node must carry metadata");
        }

        return new FileNode(metadata, content);
    }

    private FileContent? ReadContent(ref Utf8JsonReader reader, JsonSerializerOptions options)
    {
        switch (reader.TokenType)
        {
            case JsonTokenType.Null:
                return null;

            case JsonTokenType.String:
                return new FileContent.Bytes(reader.GetBytesFromBase64());

            case JsonTokenType.StartArray:
                var entries = new List<FileNode>();
                while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
                {
                    entries.Add(Read(ref reader, typeof(FileNode), options));
                }

                return new FileContent.Entries(entries);

            default:
                throw new JsonException(
                    $"content must be a string, an array or null, and was {reader.TokenType}");
        }
    }
}

/// <summary>The one serializer configuration for the document.</summary>
internal static class FileDocument
{
    /// <summary>
    /// <b>camelCase, pinned explicitly.</b> <c>MessagingJson</c> leaves the naming policy null —
    /// PascalCase — and it governs the <c>ProcessedData</c> envelope, not the bytes inside
    /// <c>Data</c>. Inheriting its convention here would silently rename every property the schema
    /// names.
    /// <para>
    /// <c>Never</c> ignore: <c>content</c> must be emitted as <c>null</c> on an empty archive rather
    /// than omitted, because the schema requires the key to be present. The converter writes that
    /// key unconditionally, so this setting governs <see cref="FileMetadata"/>'s nullable timestamps.
    /// </para>
    /// </summary>
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        Converters = { new FileNodeConverter() },
    };
}
