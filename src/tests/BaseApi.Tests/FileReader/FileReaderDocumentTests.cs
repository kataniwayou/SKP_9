using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.FileReader;
using Xunit;

namespace BaseApi.Tests.FileReader;

public sealed class FileReaderDocumentTests : IDisposable
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private readonly string _dir = Directory.CreateTempSubdirectory("skp-filereader-doc-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private string WriteText(string name, string text)
    {
        var path = Path.Combine(_dir, name);
        File.WriteAllText(path, text);
        return path;
    }

    private static (FileReaderProcessor Processor, IQueueSender Sender) Build()
    {
        var sender = Substitute.For<IQueueSender>();
        var processor = new FileReaderProcessor(
            new RecordingLogger<FileReaderProcessor>(),
            Options.Create(new FileReaderOptions()),
            new FileContentBuilder([]));
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));
        return (processor, sender);
    }

    private static async Task<List<ProcessedData>> SendsOf(
        IQueueSender sender, FileReaderProcessor processor, string path, string payload, Guid executionId)
    {
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await processor.ExecuteAsync(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { filePath = path })),
            payload, executionId, CancellationToken.None);

        return sends;
    }

    private const string CsvPayload =
        """{"ExpectedExtension":".csv","MinimumSizeBytes":0,"MaximumSizeBytes":4096}""";

    [Fact]
    public async Task APlainFileBecomesOneRootLeaf()
    {
        var (processor, sender) = Build();
        var path = WriteText("orders.csv", "id,name\n");

        var sends = await SendsOf(sender, processor, path, CsvPayload, E);

        var doc = JsonDocument.Parse(Assert.Single(sends).Data).RootElement;
        Assert.Equal("orders.csv", doc.GetProperty("metadata").GetProperty("name").GetString());
        Assert.Equal(".csv", doc.GetProperty("metadata").GetProperty("extension").GetString());
        Assert.Equal(8, doc.GetProperty("metadata").GetProperty("sizeBytes").GetInt64());
        Assert.Equal(0, doc.GetProperty("metadata").GetProperty("entryCount").GetInt32());
        Assert.Equal("id,name\n", Encoding.UTF8.GetString(doc.GetProperty("content").GetBytesFromBase64()));
        Assert.Empty(doc.GetProperty("entries").EnumerateArray());
    }

    [Fact]
    public async Task TheBranchReusesTheDispatchsExecutionId()
    {
        // This processor is a transform, not a source. Minting a new id would orphan the lineage it
        // was handed, and reusing one across several branches would make the lineage joins count
        // more than one where they expect one. Exactly one branch, on the id that arrived.
        var (processor, sender) = Build();
        var path = WriteText("orders.csv", "id\n");

        var sends = await SendsOf(sender, processor, path, CsvPayload, E);

        Assert.Equal(E, Assert.Single(sends).ExecutionId);
    }

    [Fact]
    public async Task ThePropertyNamesAreCamelCase()
    {
        // MessagingJson is PascalCase and governs the ProcessedData envelope, not these bytes. The
        // schema in Task 8 pins camelCase, and a drift here fails it one hop later where the branch
        // is DISCARDED rather than reported — so it is pinned in a unit test too.
        var (processor, sender) = Build();
        var path = WriteText("orders.csv", "id\n");

        var sends = await SendsOf(sender, processor, path, CsvPayload, E);

        var json = Encoding.UTF8.GetString(Assert.Single(sends).Data);
        Assert.Contains("\"metadata\"", json, StringComparison.Ordinal);
        Assert.Contains("\"sizeBytes\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Metadata\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"SizeBytes\"", json, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnArchiveWithNoRegisteredExtractorIsALeaf()
    {
        // No extractor is registered in these tests, so a .zip is content rather than entries. The
        // switch is the extractor set, never the file's magic bytes.
        var (processor, sender) = Build();
        var path = WriteText("bundle.zip", "not really a zip");

        var sends = await SendsOf(sender, processor, path,
            """{"ExpectedExtension":".zip","MinimumSizeBytes":0,"MaximumSizeBytes":4096}""", E);

        var doc = JsonDocument.Parse(Assert.Single(sends).Data).RootElement;
        Assert.Equal(JsonValueKind.String, doc.GetProperty("content").ValueKind);
        Assert.Empty(doc.GetProperty("entries").EnumerateArray());
    }

    [Fact]
    public async Task TheDocumentNeverMentionsProviderName()
    {
        // It rides in on the upstream record and is redundant. The design says it appears nowhere in
        // the output, and this is the test that keeps it true.
        var (processor, sender) = Build();
        var path = WriteText("orders.csv", "id\n");

        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());
        await processor.ExecuteAsync(
            Encoding.UTF8.GetBytes(
                JsonSerializer.Serialize(new { filePath = path, providerName = "acme-feed" })),
            CsvPayload, E, CancellationToken.None);

        var json = Encoding.UTF8.GetString(Assert.Single(sends).Data);
        Assert.DoesNotContain("acme", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("provider", json, StringComparison.OrdinalIgnoreCase);
    }
}
