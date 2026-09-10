using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using NSubstitute;
using Processor.ArchiveCollapser;
using Processor.ArchiveCollapser.Writers;
using Processor.ArchiveExpander.Extractors;
using Xunit;

namespace BaseApi.Tests.ArchiveCollapser;

public sealed class ProcessorArchiveCollapserTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private static DateTime Stamp => new(2026, 6, 7, 8, 9, 10, DateTimeKind.Utc);

    private static FileNode Leaf(string name, string text)
        => new(
            new FileMetadata(name, Path.GetExtension(name), text.Length, null, Stamp, 0),
            new FileContent.Bytes(Encoding.UTF8.GetBytes(text)));

    private static byte[] Document(FileNode node)
        => JsonSerializer.SerializeToUtf8Bytes(node, FileDocument.Options);

    /// <summary>Runs the real processor and returns the single branch it sent, or throws.</summary>
    private static async Task<ProcessedData> Run(byte[] data, string payload = "")
    {
        var sender = Substitute.For<IQueueSender>();
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var processor = new ArchiveCollapserProcessor(
            new RecordingLogger<ArchiveCollapserProcessor>(),
            new ArchiveBuilder([new ZipWriter(), new TarWriter()]));
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));

        await processor.ExecuteAsync(data, payload, E, CancellationToken.None);

        return Assert.Single(sends);
    }

    /// <summary>
    /// Like <see cref="Run"/>, but hands back the logger too -- for the one test that needs to read
    /// the shape the processor logs rather than the envelope it sends.
    /// </summary>
    private static async Task<(ProcessedData Sent, RecordingLogger<ArchiveCollapserProcessor> Log)> RunLogging(
        byte[] data, string payload = "")
    {
        var sender = Substitute.For<IQueueSender>();
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var log = new RecordingLogger<ArchiveCollapserProcessor>();
        var processor = new ArchiveCollapserProcessor(log, new ArchiveBuilder([new ZipWriter(), new TarWriter()]));
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));

        await processor.ExecuteAsync(data, payload, E, CancellationToken.None);

        return (Assert.Single(sends), log);
    }

    private static JsonElement Envelope(ProcessedData sent)
        => JsonDocument.Parse(sent.Data).RootElement;

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("{}")]
    [InlineData("""{"MaxDepth":3,"SomethingElse":"x"}""")]
    public async Task EveryPayloadIsAccepted(string payload)
    {
        // THE EXPLICIT INVERSE OF ArchiveExpander, WHICH REJECTS A NULL PAYLOAD. Nothing here reads
        // the config, so nothing may reject it. If someone later "fixes" this by adding a null
        // check to match the expander, these four cases are what fails. Do not delete them.
        var sent = await Run(Document(Leaf("orders.csv", "id")), payload);

        Assert.Equal("orders.csv", Envelope(sent).GetProperty("fileName").GetString());
    }

    [Fact]
    public async Task ThePlainFileEnvelopeCarriesEveryFieldFromTheRootNode()
    {
        var created = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);
        var modified = new DateTime(2026, 6, 7, 8, 9, 10, DateTimeKind.Utc);

        // Distinct values on purpose: two NotNull checks would pass just as happily if a reader
        // TRANSPOSED the two fields. Pinning each to its own value is what catches a swap.
        var node = new FileNode(
            new FileMetadata("orders.csv", ".csv", 7, created, modified, 0),
            new FileContent.Bytes(Encoding.UTF8.GetBytes("id,name")));

        var e = Envelope(await Run(Document(node)));

        Assert.Equal("orders.csv", e.GetProperty("fileName").GetString());
        Assert.Equal(".csv", e.GetProperty("extension").GetString());
        Assert.Equal(7, e.GetProperty("sizeBytes").GetInt64());
        // Zone-safe: GetDateTime() parses the "...Z" wire form back to a UTC DateTime, and Stamp/
        // created/modified are all constructed with DateTimeKind.Utc, so the comparison never
        // depends on this machine's local time zone.
        Assert.Equal(created, e.GetProperty("createdUtc").GetDateTime());
        Assert.Equal(modified, e.GetProperty("modifiedUtc").GetDateTime());
        Assert.Equal("id,name", Encoding.UTF8.GetString(e.GetProperty("content").GetBytesFromBase64()));
    }

    [Fact]
    public async Task SizeBytesIsTheArchiveProducedNotWhatTheDocumentDeclared()
    {
        // The declared number is decoration and loses to the content. A wrong value upstream must
        // not propagate into the envelope as if it were a fact.
        var node = new FileNode(
            new FileMetadata("orders.zip", ".zip", 999_999, null, Stamp, 1),
            new FileContent.Entries([Leaf("a.csv", "id")]));

        var e = Envelope(await Run(Document(node)));

        var content = e.GetProperty("content").GetBytesFromBase64();
        Assert.Equal(content.Length, e.GetProperty("sizeBytes").GetInt64());
        Assert.NotEqual(999_999, e.GetProperty("sizeBytes").GetInt64());
    }

    [Fact]
    public async Task ANullTimestampIsEmittedAsNullRatherThanOmitted()
    {
        // The envelope schema requires every key to be PRESENT. DefaultIgnoreCondition.Never is
        // what guarantees it, and this is the assertion of that.
        var e = Envelope(await Run(Document(Leaf("orders.csv", "id"))));

        Assert.Equal(JsonValueKind.Null, e.GetProperty("createdUtc").ValueKind);
    }

    [Fact]
    public async Task TheBranchReusesTheDispatchExecutionId()
    {
        // A transform continues the lineage it was handed. Not NewExecutionId().
        var sent = await Run(Document(Leaf("orders.csv", "id")));

        Assert.Equal(E, sent.ExecutionId);
    }

    [Fact]
    public async Task ADocumentThatIsNotJsonFailsWithoutQuotingIt()
    {
        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(Encoding.UTF8.GetBytes("{ this is not json")));

        Assert.Equal(
            "input branch did not carry a file document: the branch is not JSON",
            ex.Message);

        // The parse error quotes the fragment that failed to parse, and that fragment is upstream
        // content. This assertion cannot fail on its own -- the Assert.Equal above already pins the
        // message exactly -- and it stays anyway: it documents for a future reader that upstream
        // content must never reach the message, in case the catch is ever "improved" to include
        // ex.Message.
        Assert.DoesNotContain("this is not json", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ADocumentThatParsesToNullFailsWithItsOwnReason()
    {
        // Valid JSON whose value is literally `null` is a different fault than malformed JSON -- an
        // operator chasing "not JSON" here would be chasing a parse error that never happened -- so
        // it must not share ADocumentThatIsNotJsonFailsWithoutQuotingIt's reason.
        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(Encoding.UTF8.GetBytes("null")));

        Assert.Equal(
            "input branch did not carry a file document: the branch is empty",
            ex.Message);
    }

    [Fact]
    public async Task ARootNodeWithNoNameFails()
    {
        // The envelope schema declares fileName with minLength 1, so this cannot produce a valid
        // envelope. Caught here rather than one hop later, where the failure carries EntryId.Empty,
        // no payload and no name.
        var node = new FileNode(
            new FileMetadata("", "", 0, null, null, 0),
            new FileContent.Bytes([]));

        var ex = await Assert.ThrowsAsync<FailedException>(() => Run(Document(node)));

        Assert.Equal(
            "input branch did not carry a file document: the root node carries no name",
            ex.Message);
    }

    [Fact]
    public async Task AnUnpackableNodeFailsOnTheCollapsingTemplate()
    {
        var node = new FileNode(
            new FileMetadata("orders.csv", ".csv", 1, null, Stamp, 1),
            new FileContent.Entries([Leaf("a.csv", "id")]));

        var ex = await Assert.ThrowsAsync<FailedException>(() => Run(Document(node)));

        Assert.StartsWith("collapsing orders.csv failed: ", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnArchiveDocumentProducesAnArchiveTheRealExtractorCanOpen()
    {
        var node = new FileNode(
            new FileMetadata("orders.zip", ".zip", 0, null, Stamp, 2),
            new FileContent.Entries([Leaf("a.csv", "id"), Leaf("b.csv", "x")]));

        var content = Envelope(await Run(Document(node))).GetProperty("content").GetBytesFromBase64();

        using var stream = new MemoryStream(content, writable: false);
        Assert.Equal(["a.csv", "b.csv"], new ZipExtractor().Extract(stream).Select(e => e.Name).ToArray());
    }

    [Fact]
    public async Task TheLoggedEntryCountAndDepthComeFromContentNotTheDeclaredMetadata()
    {
        // Depth 2: outer.zip -> child.zip -> a.csv. The root's declared entryCount is wrong ON
        // PURPOSE -- 99 against the one real child -- so a reader who swapped built.EntryCount for
        // root.Metadata.EntryCount in ArchiveCollapserProcessor would satisfy every other test in
        // this file and be caught only here.
        var child = new FileNode(
            new FileMetadata("child.zip", ".zip", 0, null, Stamp, 1),
            new FileContent.Entries([Leaf("a.csv", "id")]));
        var root = new FileNode(
            new FileMetadata("outer.zip", ".zip", 0, null, Stamp, 99),
            new FileContent.Entries([child]));

        var (_, log) = await RunLogging(Document(root));

        Assert.Contains(log.Records, r =>
            r.Message.Contains("of 1 entries", StringComparison.Ordinal)
            && r.Message.Contains("from depth 2", StringComparison.Ordinal));
    }
}
