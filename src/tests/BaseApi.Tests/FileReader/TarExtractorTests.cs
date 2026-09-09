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
