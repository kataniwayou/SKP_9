using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.ArchiveExpander;
using Xunit;

namespace BaseApi.Tests.ArchiveExpander;

public sealed class ArchiveExpanderDocumentTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    /// <summary>The envelope FileFetcher would have sent for these bytes.</summary>
    private static byte[] Envelope(string name, byte[] content, DateTime? stamp = null)
        => JsonSerializer.SerializeToUtf8Bytes(
            new
            {
                fileName    = name,
                extension   = Path.GetExtension(name),
                sizeBytes   = (long)content.Length,
                createdUtc  = stamp,
                modifiedUtc = stamp,
                content,
            },
            new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });

    private static (ArchiveExpanderProcessor Processor, IQueueSender Sender) Build()
    {
        var sender = Substitute.For<IQueueSender>();
        var processor = new ArchiveExpanderProcessor(
            new RecordingLogger<ArchiveExpanderProcessor>(),
            new FileContentBuilder([], Options.Create(new ArchiveExpanderOptions())));
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));
        return (processor, sender);
    }

    private static async Task<List<ProcessedData>> SendsOf(
        IQueueSender sender, ArchiveExpanderProcessor processor, byte[] branch, string payload, Guid executionId)
    {
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await processor.ExecuteAsync(branch, payload, executionId, CancellationToken.None);

        return sends;
    }

    private const string DefaultPayload = """{"MaxDepth":1}""";

    [Fact]
    public async Task APlainFileBecomesOneRootLeaf()
    {
        var (processor, sender) = Build();
        var bytes = Encoding.UTF8.GetBytes("id,name\n");

        var sends = await SendsOf(sender, processor, Envelope("orders.csv", bytes), DefaultPayload, E);

        var doc = JsonDocument.Parse(Assert.Single(sends).Data).RootElement;
        Assert.Equal("orders.csv", doc.GetProperty("metadata").GetProperty("name").GetString());
        Assert.Equal(".csv", doc.GetProperty("metadata").GetProperty("extension").GetString());
        Assert.Equal(8, doc.GetProperty("metadata").GetProperty("sizeBytes").GetInt64());
        Assert.Equal(0, doc.GetProperty("metadata").GetProperty("entryCount").GetInt32());
        Assert.Equal("id,name\n", Encoding.UTF8.GetString(doc.GetProperty("content").GetBytesFromBase64()));
    }

    [Fact]
    public async Task TheBranchReusesTheDispatchsExecutionId()
    {
        // This processor is a transform, not a source. Minting a new id would orphan the lineage it
        // was handed, and reusing one across several branches would make the lineage joins count
        // more than one where they expect one. Exactly one branch, on the id that arrived.
        var (processor, sender) = Build();
        var bytes = Encoding.UTF8.GetBytes("id\n");

        var sends = await SendsOf(sender, processor, Envelope("orders.csv", bytes), DefaultPayload, E);

        Assert.Equal(E, Assert.Single(sends).ExecutionId);
    }

    [Fact]
    public async Task ThePropertyNamesAreCamelCase()
    {
        // MessagingJson is PascalCase and governs the ProcessedData envelope, not these bytes. The
        // schema in Task 8 pins camelCase, and a drift here fails it one hop later where the branch
        // is DISCARDED rather than reported — so it is pinned in a unit test too.
        var (processor, sender) = Build();
        var bytes = Encoding.UTF8.GetBytes("id\n");

        var sends = await SendsOf(sender, processor, Envelope("orders.csv", bytes), DefaultPayload, E);

        var json = Encoding.UTF8.GetString(Assert.Single(sends).Data);
        Assert.Contains("\"metadata\"", json, StringComparison.Ordinal);
        Assert.Contains("\"sizeBytes\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Metadata\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"SizeBytes\"", json, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnArchiveWithNoRegisteredExtractorIsALeaf()
    {
        // A leaf for TWO independent reasons, and either alone would do it: no extractor is
        // registered in these tests, and these bytes are not a zip whatever the name says.
        // The second is the one that holds in production - the extractor is chosen by
        // signature, and the extension only travelled through as a fact about the file.
        var (processor, sender) = Build();
        var bytes = Encoding.UTF8.GetBytes("not really a zip");

        var sends = await SendsOf(sender, processor, Envelope("bundle.zip", bytes), DefaultPayload, E);

        var doc = JsonDocument.Parse(Assert.Single(sends).Data).RootElement;
        Assert.Equal(JsonValueKind.String, doc.GetProperty("content").ValueKind);
        Assert.Equal(0, doc.GetProperty("metadata").GetProperty("entryCount").GetInt32());
    }

    [Fact]
    public async Task TheDocumentNeverMentionsProviderName()
    {
        // It rides in on the upstream record and is redundant. The design says it appears nowhere in
        // the output, and this is the test that keeps it true.
        var (processor, sender) = Build();
        var bytes = Encoding.UTF8.GetBytes("id\n");

        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var envelope = JsonSerializer.SerializeToUtf8Bytes(
            new
            {
                fileName    = "orders.csv",
                extension   = ".csv",
                sizeBytes   = (long)bytes.Length,
                createdUtc  = (DateTime?)null,
                modifiedUtc = (DateTime?)null,
                content     = bytes,
                providerName = "acme-feed",
            },
            new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });

        await processor.ExecuteAsync(envelope, DefaultPayload, E, CancellationToken.None);

        var json = Encoding.UTF8.GetString(Assert.Single(sends).Data);
        Assert.DoesNotContain("acme", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("provider", json, StringComparison.OrdinalIgnoreCase);
    }
}
