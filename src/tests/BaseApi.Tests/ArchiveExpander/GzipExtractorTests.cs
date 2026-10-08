using System.Formats.Tar;
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

public sealed class GzipExtractorTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private static GzipExtractor Extractor(long maxExpandedBytes = 33_554_432)
        => new(Options.Create(new ArchiveExpanderOptions { MaxExpandedBytes = maxExpandedBytes }));

    /// <summary>A gzip as .NET writes it: no FNAME, MTIME zero.</summary>
    private static byte[] Gzip(byte[] content)
    {
        using var buffer = new MemoryStream();
        using (var gzip = new GZipStream(buffer, CompressionLevel.Optimal, leaveOpen: true))
        {
            gzip.Write(content);
        }

        return buffer.ToArray();
    }

    /// <summary>
    /// A gzip as the gzip tool writes it: FNAME and MTIME set in the header, then the same deflate
    /// body and trailer .NET produced.
    /// </summary>
    private static byte[] GzipNamed(byte[] content, string name, uint mtime)
    {
        var plain = Gzip(content);

        using var buffer = new MemoryStream();
        buffer.Write([0x1F, 0x8B, 0x08, 0x08]);
        buffer.Write(BitConverter.GetBytes(mtime));
        buffer.Write([0x00, 0x03]);
        buffer.Write(Encoding.Latin1.GetBytes(name));
        buffer.WriteByte(0);
        buffer.Write(plain.AsSpan(10));
        return buffer.ToArray();
    }

    private static byte[] Text(string text) => Encoding.UTF8.GetBytes(text);

    [Fact]
    public void ItHandlesGzipAndNothingElse()
    {
        var extractor = Extractor();

        Assert.True(extractor.CanHandle(Gzip(Text("id\n"))));
        Assert.True(extractor.CanHandle(new byte[] { 0x1F, 0x8B, 0x08 }));

        Assert.False(extractor.CanHandle(new byte[] { 0x1F, 0x8B }));
        Assert.False(extractor.CanHandle(new byte[] { 0x1F, 0x8B, 0x07 }));
        Assert.False(extractor.CanHandle(new byte[] { 0x50, 0x4B, 0x03, 0x04 }));
        Assert.False(extractor.CanHandle(ReadOnlySpan<byte>.Empty));
    }

    [Fact]
    public void TheDecompressedFileIsTheOneEntry()
    {
        using var stream = new MemoryStream(Gzip(Text("id,name\n1,a\n")));

        var entry = Assert.Single(Extractor().Extract(stream));

        Assert.Equal("id,name\n1,a\n", Encoding.UTF8.GetString(entry.Content));

        // Neither recorded: the builder names the entry, and MTIME zero means no time, not 1970.
        Assert.Equal(string.Empty, entry.Name);
        Assert.Null(entry.ModifiedUtc);
    }

    [Fact]
    public void TheRecordedNameAndTimeAreCarried()
    {
        var mtime = (uint)new DateTimeOffset(2026, 9, 8, 10, 58, 0, TimeSpan.Zero).ToUnixTimeSeconds();
        using var stream = new MemoryStream(GzipNamed(Text("id\n"), "dir/report.csv", mtime));

        var entry = Assert.Single(Extractor().Extract(stream));

        // The path the header recorded is dropped, same as zip and tar.
        Assert.Equal("report.csv", entry.Name);
        Assert.Equal(new DateTime(2026, 9, 8, 10, 58, 0, DateTimeKind.Utc), entry.ModifiedUtc);
        Assert.Equal(DateTimeKind.Utc, entry.ModifiedUtc!.Value.Kind);
        Assert.Equal("id\n", Encoding.UTF8.GetString(entry.Content));
    }

    [Fact]
    public void AnEmptyFileCompressedIsAnEmptyEntry()
    {
        // Not the false-HEALTHY case: gzip of zero bytes is a real file, and the trailer agrees.
        using var stream = new MemoryStream(Gzip([]));

        Assert.Empty(Assert.Single(Extractor().Extract(stream)).Content);
    }

    [Fact]
    public void EveryTruncationThrowsForTheProcessorToCatch()
    {
        // THE HOLE THIS FORMAT HAS: a file cut short reading as a shorter file. Swept at every
        // length rather than one, because "every shape I tried throws" is only a proof for the
        // shapes tried — the lesson rar taught.
        var random = new Random(42);
        var content = new byte[20_000];
        random.NextBytes(content.AsSpan(0, 10_000));
        var whole = Gzip(content);

        for (var length = 0; length < whole.Length; length++)
        {
            using var stream = new MemoryStream(whole, 0, length, writable: false);

            var ex = Record.Exception(() => Extractor().Extract(stream));
            Assert.True(ex is ArchiveExtractionException,
                $"truncated to {length} of {whole.Length} bytes: {ex?.GetType().Name ?? "no exception"}");
        }
    }

    [Fact]
    public void ACorruptBodyThrowsForTheProcessorToCatch()
    {
        var bytes = Gzip(Text(string.Concat(Enumerable.Repeat("id,name\n1,a\n", 200))));
        for (var i = 12; i < bytes.Length - 8; i++)
        {
            bytes[i] ^= 0xFF;
        }

        using var stream = new MemoryStream(bytes);

        Assert.Throws<ArchiveExtractionException>(() => Extractor().Extract(stream));
    }

    [Fact]
    public void ABombStopsAtTheCeilingInsteadOfFillingMemory()
    {
        // 64 MiB of zeros deflates to ~64 KiB. The ceiling is enforced while inflating, so the
        // extractor never holds more than it — the budget in FileContentBuilder only sees entries
        // after they are fully materialised.
        var bomb = Gzip(new byte[64 * 1024 * 1024]);

        using var stream = new MemoryStream(bomb);

        var ex = Assert.Throws<ArchiveExtractionException>(
            () => Extractor(maxExpandedBytes: 1024 * 1024).Extract(stream));
        Assert.Contains("1048576 byte ceiling", ex.Message, StringComparison.Ordinal);
    }

    // --- Files written by GNU gzip 1.13, not by .NET (see Fixtures/README.md) -------------------

    private static byte[] Fixture(string name)
        => File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory, "ArchiveExpander", "Fixtures", name));

    [Fact]
    public void ARealGzipCarriesItsRecordedNameAndTime()
    {
        // The tool's default records FNAME and MTIME — the header shape no in-repo writer produces.
        using var stream = new MemoryStream(Fixture("named.csv.gz"));

        var entry = Assert.Single(Extractor().Extract(stream));

        Assert.Equal("report.csv", entry.Name);
        Assert.Equal(new DateTime(2026, 9, 8, 10, 58, 0, DateTimeKind.Utc), entry.ModifiedUtc);
        Assert.Equal("id,name\n1,a\n", Encoding.UTF8.GetString(entry.Content));
    }

    [Fact]
    public void ARealGzipWrittenWithNoNameRecordsNeither()
    {
        using var stream = new MemoryStream(Fixture("unnamed.csv.gz"));

        var entry = Assert.Single(Extractor().Extract(stream));

        Assert.Equal(string.Empty, entry.Name);
        Assert.Null(entry.ModifiedUtc);
        Assert.Equal("id,name\n1,a\n", Encoding.UTF8.GetString(entry.Content));
    }

    [Fact]
    public async Task ARealTarGzExpandsToItsEntries()
    {
        var doc = await DocumentOf("two-entries.tar.gz", Fixture("two-entries.tar.gz"), maxDepth: 2);

        var tar = doc.GetProperty("content")[0];
        Assert.Equal("two-entries.tar", Name(tar));

        var leaves = tar.GetProperty("content");
        Assert.Equal(["a.csv", "b.csv"], leaves.EnumerateArray().Select(Name).ToArray());
        Assert.Equal("id,name\n", Encoding.UTF8.GetString(leaves[1].GetProperty("content").GetBytesFromBase64()));
    }

    // --- Through the processor ---------------------------------------------------------------

    private static async Task<JsonElement> DocumentOf(string name, byte[] content, int maxDepth)
    {
        var sender = Substitute.For<IQueueSender>();
        var processor = new ArchiveExpanderProcessor(
            new RecordingLogger<ArchiveExpanderProcessor>(),
            new FileContentBuilder(
                [new ZipExtractor(), new TarExtractor(), Extractor()],
                Options.Create(new ArchiveExpanderOptions())));
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));

        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var envelope = JsonSerializer.SerializeToUtf8Bytes(
            new
            {
                fileName    = name,
                extension   = Path.GetExtension(name),
                sizeBytes   = (long)content.Length,
                createdUtc  = (DateTime?)null,
                modifiedUtc = (DateTime?)null,
                content,
            },
            new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });

        await processor.ExecuteAsync(envelope, $$"""{"MaxDepth":{{maxDepth}}}""", E, CancellationToken.None);

        return JsonDocument.Parse(Assert.Single(sends).Data).RootElement;
    }

    private static string Name(JsonElement node)
        => node.GetProperty("metadata").GetProperty("name").GetString()!;

    [Fact]
    public async Task AnUnnamedGzipEntryTakesTheArchiveNameLessItsExtension()
    {
        var doc = await DocumentOf("report.csv.gz", Gzip(Text("id\n")), maxDepth: 1);

        var leaf = doc.GetProperty("content")[0];
        Assert.Equal("report.csv", Name(leaf));
        Assert.Equal(".csv", leaf.GetProperty("metadata").GetProperty("extension").GetString());
        Assert.Equal("id\n", Encoding.UTF8.GetString(leaf.GetProperty("content").GetBytesFromBase64()));
    }

    [Fact]
    public async Task ATarGzIsTwoLevels()
    {
        using var tar = new MemoryStream();
        using (var writer = new TarWriter(tar, leaveOpen: true))
        {
            writer.WriteEntry(new PaxTarEntry(TarEntryType.RegularFile, "a.csv")
            {
                DataStream = new MemoryStream(Text("id\n")),
            });
        }

        var doc = await DocumentOf("bundle.tgz", Gzip(tar.ToArray()), maxDepth: 2);

        // .tgz unwraps to .tar, as gunzip names it, and the tar opens one level further down.
        var inner = doc.GetProperty("content")[0];
        Assert.Equal("bundle.tar", Name(inner));
        Assert.Equal("a.csv", Name(inner.GetProperty("content")[0]));
    }

    [Fact]
    public async Task ACorruptGzipFailsTheStepNamingThePath()
    {
        var bytes = Gzip(Text("id\n"))[..12];

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => DocumentOf("broken.gz", bytes, maxDepth: 1));

        Assert.Contains("extracting broken.gz failed", ex.Message, StringComparison.Ordinal);
    }
}
