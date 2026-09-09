using System.IO.Compression;
using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.FileReader;
using Processor.FileReader.Extractors;
using Xunit;

namespace BaseApi.Tests.FileReader;

public sealed class ZipExtractorTests : IDisposable
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private readonly string _dir = Directory.CreateTempSubdirectory("skp-filereader-zip-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    /// <summary>A real zip on disk, built from bytes. No fixture file, no abstraction.</summary>
    private string WriteZip(string name, params (string Entry, string Text)[] entries)
    {
        var path = Path.Combine(_dir, name);
        using var file = File.Create(path);
        using var archive = new ZipArchive(file, ZipArchiveMode.Create);
        foreach (var (entry, text) in entries)
        {
            using var writer = new StreamWriter(archive.CreateEntry(entry).Open());
            writer.Write(text);
        }

        return path;
    }

    private const string ZipPayload =
        """{"ExpectedExtension":".zip","MinimumSizeBytes":0,"MaximumSizeBytes":65536}""";

    private static (FileReaderProcessor Processor, IQueueSender Sender) Build()
    {
        var sender = Substitute.For<IQueueSender>();
        var processor = new FileReaderProcessor(
            new RecordingLogger<FileReaderProcessor>(),
            Options.Create(new FileReaderOptions()),
            new FileContentBuilder([new ZipExtractor()]));
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));
        return (processor, sender);
    }

    private static async Task<JsonElement> DocumentOf(string path)
    {
        var (processor, sender) = Build();
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await processor.ExecuteAsync(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { filePath = path })),
            ZipPayload, E, CancellationToken.None);

        return JsonDocument.Parse(Assert.Single(sends).Data).RootElement;
    }

    [Fact]
    public void ItHandlesZipAndNothingElse()
    {
        var extractor = new ZipExtractor();

        // A local file header, and the canonical empty archive's EOCD. The empty one must be
        // claimed too, or it would be mistaken for a leaf instead of reaching the exemption in
        // Extract that tells a genuinely empty zip from a corrupt one.
        Assert.True(extractor.CanHandle(new byte[] { 0x50, 0x4B, 0x03, 0x04 }));
        Assert.True(extractor.CanHandle(new byte[] { 0x50, 0x4B, 0x05, 0x06 }));

        // A rar, a truncated signature, and nothing at all. A buffer shorter than the signature is
        // answered rather than thrown on: a two-byte file is a legitimate leaf.
        Assert.False(extractor.CanHandle(new byte[] { 0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00 }));
        Assert.False(extractor.CanHandle(new byte[] { 0x50, 0x4B }));
        Assert.False(extractor.CanHandle(ReadOnlySpan<byte>.Empty));
    }

    [Fact]
    public async Task AnArchiveBecomesEntriesAndCarriesNoContentOfItsOwn()
    {
        var path = WriteZip("orders.zip", ("a.csv", "id\n"), ("b.csv", "id,name\n"));

        var doc = await DocumentOf(path);

        Assert.Equal(JsonValueKind.Array, doc.GetProperty("content").ValueKind);
        Assert.Equal(2, doc.GetProperty("metadata").GetProperty("entryCount").GetInt32());
        Assert.Equal(2, doc.GetProperty("content").GetArrayLength());
    }

    [Fact]
    public async Task EachEntryIsALeafWithItsOwnMetadata()
    {
        var path = WriteZip("orders.zip", ("a.csv", "id\n"));

        var doc = await DocumentOf(path);
        var entry = doc.GetProperty("content")[0];

        Assert.Equal("a.csv", entry.GetProperty("metadata").GetProperty("name").GetString());
        Assert.Equal(".csv", entry.GetProperty("metadata").GetProperty("extension").GetString());
        Assert.Equal(3, entry.GetProperty("metadata").GetProperty("sizeBytes").GetInt64());
        Assert.Equal("id\n", Encoding.UTF8.GetString(entry.GetProperty("content").GetBytesFromBase64()));
        Assert.Equal(0, entry.GetProperty("metadata").GetProperty("entryCount").GetInt32());
    }

    [Fact]
    public async Task ANestedArchiveIsALeafRatherThanASecondLevel()
    {
        // Depth is one, by design. The inner zip's bytes are recorded; it is not expanded.
        var inner = WriteZip("inner.zip", ("deep.csv", "id\n"));
        var path = Path.Combine(_dir, "outer.zip");
        using (var file = File.Create(path))
        using (var archive = new ZipArchive(file, ZipArchiveMode.Create))
        {
            using var target = archive.CreateEntry("inner.zip").Open();
            using var source = File.OpenRead(inner);
            source.CopyTo(target);
        }

        var doc = await DocumentOf(path);
        var entry = doc.GetProperty("content")[0];

        Assert.Equal("inner.zip", entry.GetProperty("metadata").GetProperty("name").GetString());
        Assert.Equal(JsonValueKind.String, entry.GetProperty("content").ValueKind);
        Assert.Equal(0, entry.GetProperty("metadata").GetProperty("entryCount").GetInt32());
    }

    [Fact]
    public async Task ADirectoryEntryIsNotANode()
    {
        // A zip records directories as zero-length entries ending in a slash. They carry no content
        // and no metadata worth a node, and counting them would make entryCount disagree with what a
        // reader sees.
        var path = Path.Combine(_dir, "orders.zip");
        using (var file = File.Create(path))
        using (var archive = new ZipArchive(file, ZipArchiveMode.Create))
        {
            archive.CreateEntry("nested/");
            using var writer = new StreamWriter(archive.CreateEntry("nested/a.csv").Open());
            writer.Write("id\n");
        }

        var doc = await DocumentOf(path);

        Assert.Equal(1, doc.GetProperty("metadata").GetProperty("entryCount").GetInt32());
        Assert.Equal("a.csv",
            doc.GetProperty("content")[0].GetProperty("metadata").GetProperty("name").GetString());
    }

    [Fact]
    public async Task ACorruptArchiveFailsTheStepNamingThePath()
    {
        var path = Path.Combine(_dir, "broken.zip");
        File.WriteAllText(path, "this is not a zip");

        var (processor, _) = Build();

        var ex = await Assert.ThrowsAsync<FailedException>(() => processor.ExecuteAsync(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { filePath = path })),
            ZipPayload, E, CancellationToken.None));

        Assert.Contains($"extracting {path} failed", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnArchiveExpandingPastTheCeilingFailsTheStepNamingBothNumbers()
    {
        // THE POISON-MESSAGE CASE. Before this bound, the only ceiling anywhere was on the FILE, and
        // an archive is exactly where that stops being the transient cost: this zip is a few hundred
        // bytes on disk and 200,000 bytes expanded, so it sails through every check in stage one. At
        // the real 32 MiB ceiling an ordinary 10:1 CSV zip is ~320 MB expanded plus document and
        // envelope, against a 768Mi limit.
        //
        // An OOM-kill there is not one lost message: the author never returns, so the input key is
        // never reclaimed, RabbitMQ requeues the unacked dispatch, and the replacement pod reads the
        // same key and dies the same way — taking the processor down for every workflow on that
        // queue. A FailedException is acked and terminal, which is the whole difference.
        //
        // Both numbers are asserted because an operator has to see which limit was hit and by how
        // much; a message saying only "too large" cannot be acted on.
        var path = Path.Combine(_dir, "compressible.zip");
        using (var file = File.Create(path))
        using (var archive = new ZipArchive(file, ZipArchiveMode.Create))
        {
            // Zeros, so the archive is tiny and the expansion is not. Two entries, so the bound is
            // also shown to be CUMULATIVE rather than per-entry — neither entry alone exceeds the
            // 65536 ceiling the payload names.
            foreach (var name in new[] { "a.csv", "b.csv" })
            {
                using var entry = archive.CreateEntry(name).Open();
                entry.Write(new byte[100_000]);
            }
        }

        Assert.True(new FileInfo(path).Length < 65536, "the archive itself must pass the file check");

        var (processor, _) = Build();

        var ex = await Assert.ThrowsAsync<FailedException>(() => processor.ExecuteAsync(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { filePath = path })),
            ZipPayload, E, CancellationToken.None));

        // The `extracting` template, not `rejected`: the file broke no rule, and the fault only
        // exists once the archive was opened.
        Assert.Contains($"extracting {path} failed", ex.Message, StringComparison.Ordinal);
        Assert.Contains("100000", ex.Message, StringComparison.Ordinal);
        Assert.Contains("65536", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnArchiveInsideTheCeilingStillSucceeds()
    {
        // The other side of the bound. The ceiling is inclusive and cumulative, so an archive whose
        // entries total exactly the ceiling must still pass — an off-by-one here would reject valid
        // work with a message about memory, which is the worst possible false positive for a limit
        // whose whole purpose is to be invisible until it matters.
        var path = Path.Combine(_dir, "exact.zip");
        using (var file = File.Create(path))
        using (var archive = new ZipArchive(file, ZipArchiveMode.Create))
        {
            using var entry = archive.CreateEntry("a.csv").Open();
            entry.Write(new byte[65536]);
        }

        var doc = await DocumentOf(path);

        Assert.Equal(65536, doc.GetProperty("content")[0]
                                .GetProperty("metadata").GetProperty("sizeBytes").GetInt64());
    }

    /// <summary>A real two-entry zip, in memory. The corrupt fixtures below are damaged copies of it.</summary>
    private static byte[] RealZipBytes()
    {
        using var buffer = new MemoryStream();
        using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            using (var w = new StreamWriter(archive.CreateEntry("a.csv").Open()))
            {
                w.Write("id\n");
            }

            using (var w = new StreamWriter(archive.CreateEntry("b.csv").Open()))
            {
                w.Write("id,name\n");
            }
        }

        return buffer.ToArray();
    }

    /// <summary>The offset of the End Of Central Directory record — <c>PK\x05\x06</c>, scanned from the tail.</summary>
    private static int EndOfCentralDirectoryOffset(byte[] zip)
    {
        for (var i = zip.Length - 22; i >= 0; i--)
        {
            if (zip[i] == 0x50 && zip[i + 1] == 0x4B && zip[i + 2] == 0x05 && zip[i + 3] == 0x06)
            {
                return i;
            }
        }

        throw new InvalidOperationException("the fixture has no EOCD record");
    }

    [Fact]
    public void AGenuinelyEmptyZipSucceedsWithNoEntries()
    {
        // The "valid, so must not throw" side of the guard's line, and the shape was VERIFIED here
        // rather than taken on description: a ZipArchive opened for Create and closed without a
        // single entry writes exactly 22 bytes — a bare EOCD record beginning PK\x05\x06 — on .NET
        // 8.0.31. Those two facts are what ZipExtractor's exemption tests for, so this test asserts
        // them directly; if a future runtime writes a different empty archive, this fails HERE with
        // the reason, rather than the exemption silently ceasing to match.
        byte[] empty;
        using (var buffer = new MemoryStream())
        {
            using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
            {
            }

            empty = buffer.ToArray();
        }

        Assert.Equal(22, empty.Length);
        Assert.Equal<byte[]>([0x50, 0x4B, 0x05, 0x06], empty[..4]);

        using var stream = new MemoryStream(empty, writable: false);

        Assert.Empty(new ZipExtractor().Extract(stream));
    }

    [Fact]
    public void AZipWhoseEndOfCentralDirectoryClaimsNothingThrows()
    {
        // THE MEASURED FALSE-HEALTHY HOLE, built from a real zip rather than a hand-typed blob.
        //
        // .NET 8.0.31's ZipArchive DOES cross-check the EOCD's declared entry count against what the
        // central directory yields — ~2200 mutations of this fixture (truncation at every length,
        // zeroed and 0xFF windows of eight sizes at every offset, the whole central directory
        // zeroed, everything before the EOCD zeroed, prefix and suffix padding) all threw. What it
        // does NOT cross-check is the central directory's declared size and offset. Zero the EOCD's
        // entry counts AND its central-directory size/offset — twelve bytes at the tail, the shape a
        // partially-flushed write or a padded transfer produces — and the file still holds both
        // entries, still opens cleanly, and enumerates NOTHING with no exception.
        //
        // Without the guard that is {content: null, entries: [], entryCount: 0}: schema-valid,
        // written to L2, reported Completed. This is the test that would have caught it.
        var zip = RealZipBytes();
        var eocd = EndOfCentralDirectoryOffset(zip);

        // EOCD layout from its signature: +8 entries-on-this-disk, +10 total entries, +12 central
        // directory size, +16 central directory offset. Twelve bytes, all zeroed.
        Array.Clear(zip, eocd + 8, 12);

        using var stream = new MemoryStream(zip, writable: false);

        var ex = Assert.Throws<ArchiveExtractionException>(() => new ZipExtractor().Extract(stream));
        Assert.Contains("no entries", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AZipWhoseCentralDirectoryIsZeroedThrows()
    {
        // The review's other named case: the central directory zeroed with the EOCD left intact.
        // On .NET 8.0.31 this one is caught by the runtime itself — the EOCD still declares two
        // entries and the directory now yields none, which ZipArchive rejects by name — so the
        // throw arrives through ZipExtractor's WRAPPING rather than through its guard. Both paths
        // must reach the processor as the same type, which is exactly what this pins: whichever
        // layer notices, the caller sees ArchiveExtractionException and the step names the file.
        var zip = RealZipBytes();
        var eocd = EndOfCentralDirectoryOffset(zip);
        var cdSize = BitConverter.ToInt32(zip, eocd + 12);
        var cdOffset = BitConverter.ToInt32(zip, eocd + 16);

        Array.Clear(zip, cdOffset, cdSize);

        using var stream = new MemoryStream(zip, writable: false);

        Assert.Throws<ArchiveExtractionException>(() => new ZipExtractor().Extract(stream));
    }

    [Fact]
    public void ADirectoryOnlyZipSucceedsWithNoEntries()
    {
        // The regression the raw-count split exists to prevent, and the reason the guard counts what
        // ZipArchive yielded rather than what survived the directory filter. A zip holding nothing
        // but a directory entry is healthy: it opens, it yields one entry, and the filter drops it.
        // Gating on the filtered count would report this valid archive as corrupt — the exact fault
        // fix round 2 found in tar.
        var path = Path.Combine(_dir, "dirs-only.zip");
        using (var file = File.Create(path))
        using (var archive = new ZipArchive(file, ZipArchiveMode.Create))
        {
            archive.CreateEntry("nested/");
        }

        using var stream = File.OpenRead(path);

        Assert.Empty(new ZipExtractor().Extract(stream));
    }

    [Fact]
    public void ExtractedEntryModifiedUtcCarriesUtcKind()
    {
        // Task 4 review requirement: ZipArchiveEntry.LastWriteTime is a DateTimeOffset, and
        // .UtcDateTime is the conversion that yields DateTimeKind.Utc. .DateTime or .LocalDateTime
        // would silently produce Kind.Local/Unspecified, which System.Text.Json renders without a
        // trailing Z (or with an offset) — a schema failure one hop downstream, in a branch that is
        // discarded rather than reported.
        var path = WriteZip("orders.zip", ("a.csv", "id\n"));

        using var stream = File.OpenRead(path);
        var entries = new ZipExtractor().Extract(stream);

        Assert.Equal(DateTimeKind.Utc, Assert.Single(entries).ModifiedUtc!.Value.Kind);
    }
}
