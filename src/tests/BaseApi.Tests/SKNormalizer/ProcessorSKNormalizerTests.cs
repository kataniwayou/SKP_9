using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using NSubstitute;
using Processor.SKNormalizer;
using Xunit;

namespace BaseApi.Tests.SKNormalizer;

public sealed class ProcessorSKNormalizerTests
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

    private static FileNode Archive(string name, params FileNode[] entries)
        => new(
            new FileMetadata(name, Path.GetExtension(name), 0, null, Stamp, entries.Length),
            new FileContent.Entries(entries));

    private static byte[] Document(FileNode node)
        => JsonSerializer.SerializeToUtf8Bytes(node, FileDocument.Options);

    private static (SKNormalizerProcessor Processor, RecordingLogger<SKNormalizerProcessor> Log)
        Build(params IProviderHandler[] handlers)
    {
        var log = new RecordingLogger<SKNormalizerProcessor>();

        var processor = new SKNormalizerProcessor(
            log,
            new ProviderHandlerRegistry(handlers),
            // Exploding, not a substitute: IAudioTranscoder is internal and cannot be proxied,
            // and nothing in these tests should ever convert — SampleHandler's ProfileFor returns
            // null for every item. If this throws, the handler stopped being identity.
            new NormalizationPipeline(
                new TreeAssembler(), new XmlMetadataRenderer(), new ExplodingTranscoder()),
            // These tests drive SampleHandler, which consults no whitelist, so the store is never
            // read. Supplied because the processor builds one per dispatch regardless of handler.
            new InMemoryL2().Multiplexer,
            new RecordingLogger<RedisFieldWhitelist>());

        return (processor, log);
    }

    private static async Task<ProcessedData> Run(byte[] data, string payload)
    {
        var (processor, _) = Build(new SampleHandler());

        var sender = Substitute.For<IQueueSender>();
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));
        await processor.ExecuteAsync(data, payload, E, CancellationToken.None);

        return Assert.Single(sends);
    }

    private static async Task<FailedException> Fails(byte[] data, string payload)
    {
        var (processor, _) = Build(new SampleHandler());

        var sender = Substitute.For<IQueueSender>();
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));

        return await Assert.ThrowsAsync<FailedException>(
            () => processor.ExecuteAsync(data, payload, E, CancellationToken.None));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task AnAbsentPayloadIsRejected(string payload)
    {
        // An absent payload IS a malformed payload, and it shares the prefix so one query finds every
        // payload fault including the commonest one.
        var ex = await Fails(Document(Leaf("a.csv", "id")), payload);

        Assert.StartsWith("step payload rejected:", ex.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("""{"handler":""}""")]
    [InlineData("""{"handler":"   "}""")]
    public async Task ABlankHandlerIsRejected(string payload)
    {
        var ex = await Fails(Document(Leaf("a.csv", "id")), payload);

        Assert.StartsWith("step payload rejected:", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnUnknownHandlerIsRejectedAndTheMessageNamesWhatTheBuildCarries()
    {
        // THE DIAGNOSTIC. A step wired for a handler this build predates is the one axis these drift
        // on, and listing the available names turns a guess into a read. Safe to include: handler
        // names are author constants, never upstream content.
        var ex = await Fails(Document(Leaf("a.csv", "id")), """{"handler":"NotHere"}""");

        Assert.Contains("NotHere", ex.Message, StringComparison.Ordinal);
        Assert.Contains("Sample", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheHandlerNameIsMatchedCaseInsensitively()
    {
        var sent = await Run(Document(Archive("in.zip", Leaf("a.csv", "id"))), """{"handler":"sample"}""");

        Assert.NotNull(sent.Data);
    }

    [Theory]
    [InlineData("not json at all")]
    [InlineData("null")]
    public async Task ABranchThatIsNotAFileDocumentIsRejected(string body)
    {
        var ex = await Fails(Encoding.UTF8.GetBytes(body), """{"handler":"Sample"}""");

        Assert.StartsWith("input branch did not carry a file document:", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ARootWithNoNameIsRejected()
    {
        // Caught here rather than one hop later, where the post handler reports Failed with EntryId
        // Guid.Empty, no payload and no name — nothing an operator could act on.
        var node = new FileNode(
            new FileMetadata("", "", 0, null, Stamp, 0), new FileContent.Bytes([1]));

        var ex = await Fails(Document(node), """{"handler":"Sample"}""");

        Assert.Contains("no name", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheErrorTextOfAMalformedDocumentIsNeverQuoted()
    {
        // The parse error quotes the fragment that failed, and that fragment is upstream content. The
        // CLASS of fault is what is reported; the ids in the open scope are how it is traced back.
        var ex = await Fails(
            Encoding.UTF8.GetBytes("""{"metadata":{"name":"secret-customer-name"""),
            """{"handler":"Sample"}""");

        Assert.DoesNotContain("secret-customer-name", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AFailingHandlerBecomesOneFailedStepNamingTheDocumentAndTheItem()
    {
        var (processor, _) = Build(new Throwing());

        var sender = Substitute.For<IQueueSender>();
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => processor.ExecuteAsync(
                Document(Archive("in.zip", Leaf("ninth.wav", "x"))),
                """{"handler":"Throwing"}""",
                E,
                CancellationToken.None));

        Assert.Contains("in.zip", ex.Message, StringComparison.Ordinal);
        Assert.Contains("ninth.wav", ex.Message, StringComparison.Ordinal);
    }

    private sealed class Throwing : ProviderHandlerBase
    {
        public override string Name => "Throwing";

        public override IReadOnlyList<SourceItem> Locate(FileNode root)
            => root.Content is FileContent.Entries entries
                ? entries.Value.Select(e => new SourceItem(e.Metadata.Name, [e])).ToList()
                : [];

        public override void ValidateContent(SourceItem item)
            => throw new NormalizationException("the metadata names no title");
    }

    [Fact]
    public async Task NothingIsLoggedForAFailure()
    {
        // ProcessDispatchHandler writes a FailedException's message verbatim, so a line here would
        // emit every failure twice. If this ever fails, a logger call crept into a failure path.
        var (processor, log) = Build(new SampleHandler());

        var sender = Substitute.For<IQueueSender>();
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));

        await Assert.ThrowsAsync<FailedException>(
            () => processor.ExecuteAsync([], "", E, CancellationToken.None));

        Assert.Empty(log.Records);
    }

    [Fact]
    public async Task TheSuccessLineCarriesShapeAndNeverEntryContent()
    {
        // Counts, sizes, the handler name and the ROOT file name are safe -- author constants and
        // shape, not upstream data. Item keys, field values, metadata and payload fragments are the
        // things the rule forbids, so this asserts an entry's name and its bytes both stay out.
        var (processor, log) = Build(new SampleHandler());

        var sender = Substitute.For<IQueueSender>();
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));

        await processor.ExecuteAsync(
            Document(Archive("in.zip", Leaf("secret-entry-name.csv", "id"), Leaf("b.csv", "id"))),
            """{"handler":"Sample"}""",
            E,
            CancellationToken.None);

        var entry = Assert.Single(log.Records);
        Assert.Contains("Sample", entry.Message, StringComparison.Ordinal);
        Assert.Contains("2", entry.Message, StringComparison.Ordinal);
        // An item key -- the thing the rule most specifically forbids -- must not reach the template.
        Assert.DoesNotContain("secret-entry-name", entry.Message, StringComparison.Ordinal);
        // The bytes of an entry are upstream content and must not reach a template.
        Assert.DoesNotContain("id", entry.Message, StringComparison.Ordinal);
    }
}
