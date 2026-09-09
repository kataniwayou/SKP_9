using System.Formats.Tar;
using System.Text;
using Processor.FileReader.Extractors;
using Xunit;

namespace BaseApi.Tests.FileReader;

public sealed class TarExtractorTests
{
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

        Assert.True(extractor.CanHandle(".tar"));
        Assert.True(extractor.CanHandle(".TAR"));
        Assert.False(extractor.CanHandle(".zip"));
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
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes("this is not a tar"));

        Assert.ThrowsAny<Exception>(() => new TarExtractor().Extract(stream));
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

        var ex = Assert.Throws<InvalidDataException>(() => new TarExtractor().Extract(stream));
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
