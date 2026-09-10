using System.Text;
using System.Text.Json;
using BaseProcessor.Core.Validation;
using Processor.ArchiveExpander;
using Xunit;

namespace BaseApi.Tests.ArchiveExpander;

/// <summary>
/// The schema, against the documents this processor actually emits — and through the SAME validator
/// the post handler uses, not a different JSON Schema library configured differently.
/// <para>
/// It matters more than a schema test usually would. A schema failure in production is DESTRUCTIVE:
/// the post handler reports Failed with EntryId Guid.Empty and acks, so nothing is written to L2 and
/// the step's input was already reclaimed. The file has been read, decoded and expanded, and the
/// result is discarded with no key to recover it.
/// </para>
/// </summary>
public sealed class ArchiveExpanderSchemaTests
{
    private static string Definition()
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Schemas", "tree.json"));

    private static byte[] Serialize(FileNode node)
        => JsonSerializer.SerializeToUtf8Bytes(node, FileDocument.Options);

    private static DateTime Stamp => new(2026, 9, 8, 11, 2, 14, DateTimeKind.Utc);

    private static FileNode Leaf(string name, string extension, string text)
        => new(
            new FileMetadata(name, extension, text.Length, Stamp, Stamp, 0),
            new FileContent.Bytes(Encoding.UTF8.GetBytes(text)));

    private static FileNode Archive(string name, params FileNode[] entries)
        => new(
            new FileMetadata(name, ".zip", 40219, Stamp, Stamp, entries.Length),
            entries.Length == 0 ? null : new FileContent.Entries(entries));

    [Fact]
    public void APlainFileDocumentValidates()
    {
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Serialize(Leaf("orders.csv", ".csv", "id")), out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void AnArchiveDocumentValidates()
    {
        var archive = Archive(
            "orders.zip", Leaf("a.csv", ".csv", "id"), Leaf("b.csv", ".csv", "id,name"));

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Serialize(archive), out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void AnArchiveThatExpandedToNothingValidates()
    {
        // content: null is the third form the root may take, and it is the one an empty archive
        // produces. It is NOT an empty array — see FileNode.Content.
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Serialize(Archive("empty.zip")), out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void APascalCaseDocumentIsRejected()
    {
        // The drift this schema exists to catch. MessagingJson is PascalCase and governs the
        // envelope; a document serialized with those options instead of FileDocument.Options would
        // rename every property here.
        //
        // It ALSO drops FileNodeConverter, so content would be written as whatever the default
        // serializer makes of the FileContent hierarchy rather than as one value. Either failure
        // alone is enough; the schema catches both as the same rejection.
        //
        // global:: because this namespace (BaseApi.Tests.ArchiveExpander) has a sibling
        // BaseApi.Tests.Messaging namespace that shadows the unqualified "Messaging" lookup.
        var pascal = JsonSerializer.SerializeToUtf8Bytes(
            Leaf("orders.csv", ".csv", "id"), global::Messaging.Contracts.MessagingJson.Options);

        var ok = ProcessorJsonSchemaValidator.TryValidate(Definition(), pascal, out _);

        Assert.False(ok);
    }

    [Fact]
    public void AnUnknownPropertyIsRejected()
    {
        // additionalProperties:false is what makes this a structural contract rather than a set of
        // suggestions — and it is how providerName leaking into the document would be caught.
        var json = """
            {"metadata":{"name":"a.csv","extension":".csv","sizeBytes":3,"createdUtc":null,
             "modifiedUtc":null,"entryCount":0},"content":"aWQK",
             "providerName":"acme"}
            """;

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes(json), out _);

        Assert.False(ok);
    }

    [Fact]
    public void ASeparateEntriesKeyIsRejected()
    {
        // The shape this document had before content became one key. A producer still writing the
        // old pair must not pass: `entries` is now an unknown property, and additionalProperties
        // false is what says so.
        var json = """
            {"metadata":{"name":"o.zip","extension":".zip","sizeBytes":9,"createdUtc":null,
             "modifiedUtc":null,"entryCount":0},"content":null,"entries":[]}
            """;

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes(json), out _);

        Assert.False(ok);
    }

    [Fact]
    public void ADocumentNestedDeeperThanTheSchemaAdmitsIsRejected()
    {
        // THE DEPTH RULE, and it is structural rather than declared: the baseline unrolls to one
        // level, so `depth0` admits only a string and an entry carrying its own entries has nowhere
        // to validate against.
        //
        // This is the failure a step whose MaxDepth exceeds the registered schema produces. It is
        // the contract working — nothing keeps MaxDepth and the schema in sync on purpose — and it
        // is why ArchiveExpanderProcessor logs the depth it actually reached: this rejection carries no
        // file path and no payload by the time an operator sees it.
        var json = """
            {"metadata":{"name":"o.zip","extension":".zip","sizeBytes":9,"createdUtc":null,
             "modifiedUtc":null,"entryCount":1},
             "content":[{"metadata":{"name":"i.zip","extension":".zip","sizeBytes":3,
               "createdUtc":null,"modifiedUtc":null,"entryCount":1},
               "content":[{"metadata":{"name":"d.csv","extension":".csv","sizeBytes":3,
                 "createdUtc":null,"modifiedUtc":null,"entryCount":0},"content":"aWQK"}]}]}
            """;

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes(json), out _);

        Assert.False(ok);
    }

    [Fact]
    public void ADocumentRoundTripsThroughTheConverter()
    {
        // The converter's Read exists for this: asserting on the SHAPE that comes back rather than
        // on a string, so a change to whitespace or property order does not read as a regression.
        var archive = Archive("orders.zip", Leaf("a.csv", ".csv", "id"));

        var back = JsonSerializer.Deserialize<FileNode>(Serialize(archive), FileDocument.Options);

        var entries = Assert.IsType<FileContent.Entries>(back!.Content);
        var bytes = Assert.IsType<FileContent.Bytes>(Assert.Single(entries.Value).Content);
        Assert.Equal("id", Encoding.UTF8.GetString(bytes.Value));
    }
}
