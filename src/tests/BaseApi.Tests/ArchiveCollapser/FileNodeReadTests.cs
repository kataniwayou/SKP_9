using System.Text;
using System.Text.Json;
using Processor.ArchiveCollapser;
using Xunit;

namespace BaseApi.Tests.ArchiveCollapser;

/// <summary>
/// Reading is this assembly's production path, so it gets the test ArchiveExpander gives writing.
/// </summary>
public sealed class FileNodeReadTests
{
    private static FileNode Read(string json)
        => JsonSerializer.Deserialize<FileNode>(Encoding.UTF8.GetBytes(json), FileDocument.Options)!;

    [Fact]
    public void ABase64ContentReadsAsBytes()
    {
        var node = Read(
            """
            {"metadata":{"name":"a.csv","extension":".csv","sizeBytes":2,
              "createdUtc":null,"modifiedUtc":"2026-01-02T03:04:05Z","entryCount":0},
             "content":"aWQ="}
            """);

        Assert.Equal("a.csv", node.Metadata.Name);
        Assert.Equal(new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc), node.Metadata.ModifiedUtc);
        Assert.Null(node.Metadata.CreatedUtc);
        var bytes = Assert.IsType<FileContent.Bytes>(node.Content);
        Assert.Equal("id", Encoding.UTF8.GetString(bytes.Value));
    }

    [Fact]
    public void AnArrayContentReadsAsEntries()
    {
        var node = Read(
            """
            {"metadata":{"name":"o.zip","extension":".zip","sizeBytes":9,
              "createdUtc":null,"modifiedUtc":null,"entryCount":1},
             "content":[
               {"metadata":{"name":"a.csv","extension":".csv","sizeBytes":2,
                 "createdUtc":null,"modifiedUtc":null,"entryCount":0},
                "content":"aWQ="}]}
            """);

        var entries = Assert.IsType<FileContent.Entries>(node.Content);
        Assert.Equal("a.csv", Assert.Single(entries.Value).Metadata.Name);
    }

    [Fact]
    public void ANullContentReadsAsNull()
    {
        var node = Read(
            """
            {"metadata":{"name":"empty.zip","extension":".zip","sizeBytes":22,
              "createdUtc":null,"modifiedUtc":null,"entryCount":0},
             "content":null}
            """);

        Assert.Null(node.Content);
    }

    [Fact]
    public void ADeeplyNestedDocumentIsRefusedByTheDeserializer()
    {
        // THE FIRST DEPTH GUARD, and it is not ArchiveBuilder's. FileNodeConverter.Read recurses
        // while deserializing, so a pathologically deep document would overflow the stack before
        // the builder ever sees a tree. JsonSerializerOptions.MaxDepth defaults to 64 and each node
        // costs two levels of JSON, so the tree is capped around 32 node levels and the failure is
        // a JsonException the processor already catches.
        //
        // This test MEASURES that claim rather than trusting it. If it fails, the guard is not
        // where this comment says and ArchiveBuilder.MaxSupportedDepth is the only bound -- which
        // is a stack overflow risk, not a failed step. Fix by pinning MaxDepth explicitly in
        // FileDocument.Options rather than by deleting this test.
        var json = new StringBuilder();
        const int levels = 200;

        for (var i = 0; i < levels; i++)
        {
            json.Append(
                """{"metadata":{"name":"a.zip","extension":".zip","sizeBytes":1,"createdUtc":null,"modifiedUtc":null,"entryCount":1},"content":[""");
        }

        json.Append(
            """{"metadata":{"name":"leaf.csv","extension":".csv","sizeBytes":1,"createdUtc":null,"modifiedUtc":null,"entryCount":0},"content":"aQ=="}""");

        for (var i = 0; i < levels; i++)
        {
            json.Append("]}");
        }

        Assert.Throws<JsonException>(() => Read(json.ToString()));
    }
}
