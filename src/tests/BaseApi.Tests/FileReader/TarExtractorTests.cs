using System.Formats.Tar;
using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.FileReader;
using Processor.FileReader.Extractors;
using Xunit;

namespace BaseApi.Tests.FileReader;

public sealed class TarExtractorTests : IDisposable
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private readonly string _dir = Directory.CreateTempSubdirectory("skp-filereader-tar-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    /// <summary>A real tar, built in memory from bytes.</summary>
    private static byte[] Tar(params (string Name, string Text)[] entries)
    {
        using var buffer = new MemoryStream();
        using (var writer = new TarWriter(buffer, leaveOpen: true))
        {
            foreach (var (name, text) in entries)
            {
                var entry = new PaxTarEntry(TarEntryType.RegularFile, name)
                {
                    DataStream = new MemoryStream(Encoding.UTF8.GetBytes(text)),
                    ModificationTime = new DateTimeOffset(2026, 9, 8, 10, 58, 0, TimeSpan.Zero),
                };
                writer.WriteEntry(entry);
            }
        }

        return buffer.ToArray();
    }

    [Fact]
    public void ItHandlesTarAndNothingElse()
    {
        var extractor = new TarExtractor();

        // TAR IS THE ONE FORMAT WITH NO SIGNATURE AT OFFSET ZERO: its magic is "ustar" at byte
        // 257, so this needs 262 bytes where zip needs four.
        var header = new byte[262];
        "ustar"u8.CopyTo(header.AsSpan(257));
        Assert.True(extractor.CanHandle(header));

        // One byte short of the marker, and a zip. A file too small to hold the marker cannot be a
        // tar at all - the header block alone is 512 bytes.
        Assert.False(extractor.CanHandle(header.AsSpan(0, 261)));
        Assert.False(extractor.CanHandle(new byte[] { 0x50, 0x4B, 0x03, 0x04 }));
        Assert.False(extractor.CanHandle(ReadOnlySpan<byte>.Empty));
    }

    [Fact]
    public void EveryRegularFileBecomesAnEntry()
    {
        using var stream = new MemoryStream(Tar(("a.csv", "id\n"), ("b.csv", "id,name\n")));

        var entries = new TarExtractor().Extract(stream);

        Assert.Equal(["a.csv", "b.csv"], entries.Select(e => e.Name).ToArray());
        Assert.Equal("id\n", Encoding.UTF8.GetString(entries[0].Content));
        Assert.Equal(new DateTime(2026, 9, 8, 10, 58, 0, DateTimeKind.Utc), entries[0].ModifiedUtc);
    }

    [Fact]
    public void ADirectoryEntryIsSkipped()
    {
        using var buffer = new MemoryStream();
        using (var writer = new TarWriter(buffer, leaveOpen: true))
        {
            writer.WriteEntry(new PaxTarEntry(TarEntryType.Directory, "nested/"));
            writer.WriteEntry(new PaxTarEntry(TarEntryType.RegularFile, "nested/a.csv")
            {
                DataStream = new MemoryStream(Encoding.UTF8.GetBytes("id\n")),
            });
        }

        buffer.Position = 0;
        var entries = new TarExtractor().Extract(buffer);

        Assert.Equal("a.csv", Assert.Single(entries).Name);
    }

    [Fact]
    public void ATruncatedArchiveThrowsForTheProcessorToCatch()
    {
        // The processor turns this into a failed step naming the path; the extractor's job is only
        // to fail rather than to return a half-read archive as if it were whole.
        //
        // ArchiveExtractionException, not ThrowsAny<Exception>. A test named "for the processor to
        // catch" that accepts ANY exception cannot tell the two cases apart — the one the processor
        // catches and turns into "extracting {path} failed", and the one that escapes to the
        // framework's general catch and loses the path entirely. Asserting the seam's type is the
        // only assertion that means what the name says.
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes("this is not a tar"));

        Assert.Throws<ArchiveExtractionException>(() => new TarExtractor().Extract(stream));
    }

    [Fact]
    public void AGenuinelyEmptyTarSucceedsWithNoEntries()
    {
        // A valid empty tar is nothing but zero bytes — a lone 512-byte zero block satisfies it,
        // same as the POSIX-standard two-block terminator, same as 0 bytes. TarReader.GetNextEntry
        // returns null with no exception for all of these, same as it does for a corrupt archive
        // (see ATruncatedHeaderWithGarbageAfterItThrows below) — the guard in TarExtractor.Extract
        // tells them apart by checking whether the stream is all zero. This pins the "valid, so must
        // not throw" side of that line.
        using var stream = new MemoryStream(new byte[1024]);

        var entries = new TarExtractor().Extract(stream);

        Assert.Empty(entries);
    }

    [Fact]
    public void ATruncatedHeaderWithGarbageAfterItThrows()
    {
        // The false-HEALTHY case the guard exists for: TarReader reads the first block, sees it is
        // all zero, and treats that as the archive's terminator — GetNextEntry returns null with NO
        // exception, exactly as it would for a real empty tar. Without the guard, a file that was
        // truncated right after a zeroed header (or any file whose first 512 bytes happen to be
        // zero, with real bytes after them) would read as a healthy empty archive instead of a
        // corrupt one. Measured directly against TarReader before writing this test — see
        // task-6-report.md, fix round 1.
        var bytes = new byte[522];
        Encoding.UTF8.GetBytes("garbagexyz").CopyTo(bytes, 512);

        using var stream = new MemoryStream(bytes);

        var ex = Assert.Throws<ArchiveExtractionException>(() => new TarExtractor().Extract(stream));
        Assert.Contains("not all zero", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ADirectoryOnlyArchiveSucceedsWithNoEntries()
    {
        // Fix round 2 regression: the guard above must gate on what TarReader actually yielded, not
        // on what survived the regular-file filter. A directory-only archive (same as one that held
        // only symlinks, hardlinks, or the excluded ContiguousFile/SparseFile types) parses cleanly —
        // TarReader reads a real, non-zero header and yields one entry — but the filter drops it, so
        // entries.Count is 0. Gating the guard on entries.Count made this valid, non-corrupt archive
        // throw InvalidDataException; gating on the raw TarReader yield count (which is 1, not 0)
        // fixes it. This test is the third side of the "empty vs. corrupt" line, alongside
        // AGenuinelyEmptyTarSucceedsWithNoEntries and ATruncatedHeaderWithGarbageAfterItThrows.
        using var buffer = new MemoryStream();
        using (var writer = new TarWriter(buffer, leaveOpen: true))
        {
            writer.WriteEntry(new PaxTarEntry(TarEntryType.Directory, "emptydir/"));
        }

        buffer.Position = 0;
        var entries = new TarExtractor().Extract(buffer);

        Assert.Empty(entries);
    }

    [Fact]
    public async Task ACorruptArchiveFailsTheStepNamingThePath()
    {
        // THE PROCESSOR-LEVEL TEST TAR NEVER HAD. Only zip had one, which is why nobody noticed that
        // the processor's catch list was written against zip's exception types and matched nothing
        // any other library raises. An extractor-level assertion proves the extractor throws; it
        // proves nothing about whether the throw reaches the caller's catch or escapes to the
        // framework's general one, where the file path — the entire reason §9 puts these checks in
        // ProcessAsync — is absent from every line.
        var path = Path.Combine(_dir, "broken.tar");
        File.WriteAllText(path, "this is not a tar");

        var processor = new FileReaderProcessor(
            new RecordingLogger<FileReaderProcessor>(),
            Options.Create(new FileReaderOptions()),
            new FileContentBuilder([new TarExtractor()]));
        processor.BeginDispatch(
            new DispatchState(Substitute.For<IQueueSender>(), C, W, S, P));

        var ex = await Assert.ThrowsAsync<FailedException>(() => processor.ExecuteAsync(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { filePath = path })),
            """{"ExpectedExtension":".tar","MinimumSizeBytes":0,"MaximumSizeBytes":65536}""",
            E, CancellationToken.None));

        Assert.Contains($"extracting {path} failed", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ExtractedEntryModifiedUtcCarriesUtcKind()
    {
        // Task 4/6 review requirement: TarEntry.ModificationTime is a DateTimeOffset, and
        // .UtcDateTime is the conversion that yields DateTimeKind.Utc. .DateTime or .LocalDateTime
        // would silently produce Kind.Local/Unspecified, which System.Text.Json renders without a
        // trailing Z (or with an offset) — a schema failure one hop downstream, in a branch that is
        // discarded rather than reported.
        using var stream = new MemoryStream(Tar(("a.csv", "id\n")));

        var entries = new TarExtractor().Extract(stream);

        Assert.Equal(DateTimeKind.Utc, Assert.Single(entries).ModifiedUtc!.Value.Kind);
    }
}
