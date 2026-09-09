using System.Text;
using System.Text.Json;
using BaseProcessor.Core.Validation;
using Processor.FileReader;
using Xunit;

namespace BaseApi.Tests.FileReader;

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
public sealed class FileReaderSchemaTests
{
    private static string Definition()
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "schema", "output.json"));

    private static byte[] Serialize(FileNode node)
        => JsonSerializer.SerializeToUtf8Bytes(node, FileDocument.Options);

    private static FileNode Leaf(string name, string extension, string text)
        => new(
            new FileMetadata(name, extension, text.Length,
                new DateTime(2026, 9, 8, 11, 2, 14, DateTimeKind.Utc),
                new DateTime(2026, 9, 8, 11, 2, 14, DateTimeKind.Utc), 0),
            Encoding.UTF8.GetBytes(text),
            []);

    [Fact]
    public void APlainFileDocumentValidates()
    {
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Serialize(Leaf("orders.csv", ".csv", "id\n")), out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void AnArchiveDocumentValidates()
    {
        var archive = new FileNode(
            new FileMetadata("orders.zip", ".zip", 40219,
                new DateTime(2026, 9, 8, 11, 2, 14, DateTimeKind.Utc),
                new DateTime(2026, 9, 8, 11, 2, 14, DateTimeKind.Utc), 2),
            Content: null,
            [Leaf("a.csv", ".csv", "id\n"), Leaf("b.csv", ".csv", "id,name\n")]);

        var ok = ProcessorJsonSchemaValidator.TryValidate(Definition(), Serialize(archive), out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void APascalCaseDocumentIsRejected()
    {
        // The drift this schema exists to catch. MessagingJson is PascalCase and governs the
        // envelope; a document serialized with those options instead of FileDocument.Options would
        // rename every property here.
        // global:: because this namespace (BaseApi.Tests.FileReader) has a sibling
        // BaseApi.Tests.Messaging namespace that shadows the unqualified "Messaging" lookup.
        var pascal = JsonSerializer.SerializeToUtf8Bytes(
            Leaf("orders.csv", ".csv", "id\n"), global::Messaging.Contracts.MessagingJson.Options);

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
             "modifiedUtc":null,"entryCount":0},"content":"aWQK","entries":[],
             "providerName":"acme"}
            """;

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes(json), out _);

        Assert.False(ok);
    }

    [Fact]
    public void AnEntryThatCarriesItsOwnEntriesIsRejected()
    {
        // Depth is one. A document claiming two levels did not come from this processor.
        var json = """
            {"metadata":{"name":"o.zip","extension":".zip","sizeBytes":9,"createdUtc":null,
             "modifiedUtc":null,"entryCount":1},"content":null,
             "entries":[{"metadata":{"name":"i.zip","extension":".zip","sizeBytes":3,
               "createdUtc":null,"modifiedUtc":null,"entryCount":1},"content":"aWQK",
               "entries":[{"metadata":{"name":"d.csv","extension":".csv","sizeBytes":3,
                 "createdUtc":null,"modifiedUtc":null,"entryCount":0},"content":"aWQK",
                 "entries":[]}]}]}
            """;

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes(json), out _);

        Assert.False(ok);
    }
}
