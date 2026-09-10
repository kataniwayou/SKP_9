using System.IO.Compression;
using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.ArchiveExpander;
using Processor.ArchiveExpander.Extractors;
using Xunit;

namespace BaseApi.Tests.ArchiveExpander;

/// <summary>
/// Nested expansion: how far it goes, what stops it, and what the stopping looks like in the
/// document.
/// <para>
/// The two stop conditions are independent and both are pinned here — the depth limit, and running
/// out of archives. A test that only ever hit one of them would pass with the other broken.
/// </para>
/// </summary>
public sealed class ArchiveExpanderDepthTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    /// <summary>A zip in memory, so one can be nested inside another without touching disk.</summary>
    private static byte[] ZipOf(params (string Name, byte[] Content)[] entries)
    {
        using var buffer = new MemoryStream();
        using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (name, content) in entries)
            {
                using var stream = archive.CreateEntry(name).Open();
                stream.Write(content);
            }
        }

        return buffer.ToArray();
    }

    private static byte[] Text(string text) => Encoding.UTF8.GetBytes(text);

    /// <summary>outer.zip → a.zip, b.zip → one csv each. Two levels of nesting below the root.</summary>
    private static byte[] ZipOfZips()
        => ZipOf(
            ("a.zip", ZipOf(("a.csv", Text("id,name")))),
            ("b.zip", ZipOf(("b.csv", Text("id,name")))));

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

    private static string Payload(int? maxDepth = null)
        => maxDepth is null ? "{}" : $$"""{"MaxDepth":{{maxDepth}}}""";

    private static (ArchiveExpanderProcessor Processor, IQueueSender Sender, RecordingLogger<ArchiveExpanderProcessor> Log) Build(
        long maxExpandedBytes = 33_554_432)
    {
        var sender = Substitute.For<IQueueSender>();
        var log = new RecordingLogger<ArchiveExpanderProcessor>();
        var processor = new ArchiveExpanderProcessor(
            log,
            new FileContentBuilder(
                [new ZipExtractor(), new TarExtractor()],
                Options.Create(new ArchiveExpanderOptions { MaxExpandedBytes = maxExpandedBytes })));
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));
        return (processor, sender, log);
    }

    private static async Task<JsonElement> DocumentOf(
        string name, byte[] content, string payload, long maxExpandedBytes = 33_554_432)
    {
        var (processor, sender, _) = Build(maxExpandedBytes);
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await processor.ExecuteAsync(Envelope(name, content), payload, E, CancellationToken.None);

        return JsonDocument.Parse(Assert.Single(sends).Data).RootElement;
    }

    private static JsonElement Entry(JsonElement node, int index) => node.GetProperty("content")[index];

    private static string Name(JsonElement node)
        => node.GetProperty("metadata").GetProperty("name").GetString()!;

    [Fact]
    public async Task WithNoMaxDepthANestedArchiveStaysAFile()
    {
        // THE DEFAULT, and it is what this processor did before nesting existed. Every workflow
        // authored without the field keeps documents of exactly this shape.
        var doc = await DocumentOf("outer.zip", ZipOfZips(), Payload());

        var inner = Entry(doc, 0);
        Assert.Equal("a.zip", Name(inner));

        // A base64 string, not an array: an archive that was not opened is a file, and it carries
        // its own bytes like any other.
        Assert.Equal(JsonValueKind.String, inner.GetProperty("content").ValueKind);
        Assert.Equal(0, inner.GetProperty("metadata").GetProperty("entryCount").GetInt32());
    }

    [Fact]
    public async Task MaxDepthTwoExpandsAZipOfZips()
    {
        var doc = await DocumentOf("outer.zip", ZipOfZips(), Payload(maxDepth: 2));

        Assert.Equal(2, doc.GetProperty("metadata").GetProperty("entryCount").GetInt32());
        Assert.Equal(2, doc.GetProperty("content").GetArrayLength());

        var inner = Entry(doc, 0);
        Assert.Equal("a.zip", Name(inner));
        Assert.Equal(1, inner.GetProperty("metadata").GetProperty("entryCount").GetInt32());

        var leaf = Entry(inner, 0);
        Assert.Equal("a.csv", Name(leaf));
        Assert.Equal("id,name", Encoding.UTF8.GetString(leaf.GetProperty("content").GetBytesFromBase64()));
    }

    [Fact]
    public async Task ExpansionStopsWhenNothingIsAnArchive()
    {
        // THE OTHER STOP CONDITION. MaxDepth is the ceiling itself and the file only nests two
        // deep, so the walk ends because nothing left matches a signature — not because a limit was
        // reached. Named via the constant rather than a literal: this read "8" until
        // MaxSupportedDepth came down to 4, at which point the generous-looking number was a
        // rejected payload and the test no longer reached its own assertion.
        var doc = await DocumentOf(
            "outer.zip", ZipOfZips(), Payload(maxDepth: ArchiveExpanderConfig.MaxSupportedDepth));

        var leaf = Entry(Entry(doc, 0), 0);
        Assert.Equal("a.csv", Name(leaf));
        Assert.Equal(JsonValueKind.String, leaf.GetProperty("content").ValueKind);
    }

    [Fact]
    public async Task TheDepthReachedIsLogged()
    {
        // It is logged because it survives nowhere else: a document deeper than the registered
        // schema fails validation one hop later with EntryId Guid.Empty, no payload and no name.
        var (processor, sender, log) = Build();
        await processor.ExecuteAsync(
            Envelope("outer.zip", ZipOfZips()), Payload(maxDepth: 2), E, CancellationToken.None);

        Assert.Contains(log.Records, r => r.Message.Contains("reaching depth 2 of 2",
                                                            StringComparison.Ordinal));
        _ = sender;
    }

    [Fact]
    public async Task AnEmptyArchiveCarriesNullRatherThanAnEmptyArray()
    {
        var doc = await DocumentOf("empty.zip", ZipOf(), Payload());

        Assert.Equal(JsonValueKind.Null, doc.GetProperty("content").ValueKind);
        Assert.Equal(0, doc.GetProperty("metadata").GetProperty("entryCount").GetInt32());
    }

    [Fact]
    public async Task TheCeilingIsOneRunningTotalAcrossEveryLevel()
    {
        // THE BOUND THAT MAKES DEPTH SAFE TO RAISE. Neither level alone crosses the ceiling; their
        // sum does. A per-level budget would admit this file, and the pod's memory does not care
        // which level a byte came from.
        var leaf = Text(new string('x', 4096));
        var bytes = ZipOf(
            ("a.zip", ZipOf(("a.txt", leaf))),
            ("b.zip", ZipOf(("b.txt", leaf))));

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => DocumentOf("big.zip", bytes, Payload(maxDepth: 2), maxExpandedBytes: 6000));

        Assert.Contains("extracting big.zip failed", ex.Message, StringComparison.Ordinal);
        Assert.Contains("bounds the expansion as well as the file", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ADepthOutsideTheSupportedRangeIsARejectedPayload()
    {
        var (processor, _, _) = Build();
        var bytes = ZipOfZips();

        foreach (var depth in new[] { 0, -1, ArchiveExpanderConfig.MaxSupportedDepth + 1 })
        {
            var ex = await Assert.ThrowsAsync<FailedException>(() => processor.ExecuteAsync(
                Envelope("outer.zip", bytes), Payload(maxDepth: depth), E, CancellationToken.None));

            // The payload class, diagnosed before the archive is opened — not a "rejected" file and
            // not an extraction fault.
            Assert.Contains("step payload rejected", ex.Message, StringComparison.Ordinal);
            Assert.Contains("MaxDepth", ex.Message, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task ANestedEntryIsChosenByItsBytesAndNotItsName()
    {
        // The entry is a real zip called ".dat". At the top level a name like that would never be
        // admitted; inside an archive there is no declaration to check, so the bytes are all there
        // is — and they are what decides.
        var bytes = ZipOf(("payload.dat", ZipOf(("inner.csv", Text("id")))));

        var doc = await DocumentOf("outer.zip", bytes, Payload(maxDepth: 2));

        var inner = Entry(doc, 0);
        Assert.Equal("payload.dat", Name(inner));
        Assert.Equal(JsonValueKind.Array, inner.GetProperty("content").ValueKind);
        Assert.Equal("inner.csv", Name(Entry(inner, 0)));
    }

    [Fact]
    public async Task ANestedEntryThatIsNotAnArchiveIsALeafWhateverItIsCalled()
    {
        // The mirror of the test above, and the reason the top-level cross-check does not apply
        // here: an entry named ".zip" whose bytes are not one is simply a file. Failing the step on
        // it would let whoever built the archive decide whether this processor succeeds.
        var bytes = ZipOf(("notreally.zip", Text("this is not a zip")));

        var doc = await DocumentOf("outer.zip", bytes, Payload(maxDepth: 4));

        var inner = Entry(doc, 0);
        Assert.Equal("notreally.zip", Name(inner));
        Assert.Equal(JsonValueKind.String, inner.GetProperty("content").ValueKind);
    }

    [Fact]
    public async Task ATopLevelFileNamedAsAnArchiveMustActuallyBeOne()
    {
        // THE CROSS-CHECK, and it exists because signature dispatch would otherwise turn corruption
        // into success: a damaged zip matches nothing, so without this it would be recorded as a
        // plain file and the step would report Completed over something nobody can open.
        var bytes = Text("this is not a zip");

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => DocumentOf("broken.zip", bytes, Payload()));

        Assert.Contains("extracting broken.zip failed", ex.Message, StringComparison.Ordinal);
        Assert.Contains("no archive this processor knows", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ATopLevelFileWhoseBytesAreADifferentArchiveIsStillRead()
    {
        // The cross-check asks whether the bytes are AN archive, not whether they are the named one.
        // A tar called .zip is read as a tar: an extractor claims it, and reading the content is a
        // more useful answer than refusing the name.
        var bytes = TarOf("a.csv", Text("id"));

        var doc = await DocumentOf("mislabelled.zip", bytes, Payload());

        Assert.Equal(JsonValueKind.Array, doc.GetProperty("content").ValueKind);
        Assert.Equal("a.csv", Name(Entry(doc, 0)));
    }

    /// <summary>A one-entry tar in memory, for the mislabelling test above.</summary>
    private static byte[] TarOf(string name, byte[] content)
    {
        var path = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName());
        File.WriteAllBytes(path, content);

        try
        {
            using var buffer = new MemoryStream();
            using (var writer = new System.Formats.Tar.TarWriter(buffer, leaveOpen: true))
            {
                writer.WriteEntry(path, name);
            }

            return buffer.ToArray();
        }
        finally
        {
            File.Delete(path);
        }
    }
}
