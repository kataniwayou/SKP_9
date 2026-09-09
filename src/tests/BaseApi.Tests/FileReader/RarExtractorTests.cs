using System.Text;
using Processor.FileReader.Extractors;
using Xunit;

namespace BaseApi.Tests.FileReader;

/// <summary>
/// Rar, against a committed fixture. Every other extractor's test builds its archive from bytes;
/// this one cannot, because SharpCompress reads rar and cannot write one. See Fixtures/README.md for
/// how the file is regenerated.
/// </summary>
public sealed class RarExtractorTests
{
    private static Stream Fixture()
        => File.OpenRead(Path.Combine(
            AppContext.BaseDirectory, "FileReader", "Fixtures", "three-entries.rar"));

    [Fact]
    public void ItHandlesRarAndNothingElse()
    {
        var extractor = new RarExtractor();

        Assert.True(extractor.CanHandle(".rar"));
        Assert.True(extractor.CanHandle(".RAR"));
        Assert.False(extractor.CanHandle(".zip"));
    }

    [Fact]
    public void EveryFileInTheArchiveBecomesAnEntry()
    {
        using var stream = Fixture();

        var entries = new RarExtractor().Extract(stream);

        Assert.Equal(3, entries.Count);
        Assert.Contains(entries, e => e.Name == "a.csv");
        Assert.Contains(entries, e => e.Name == "b.csv");
        Assert.Contains(entries, e => e.Name == "c.wav");
    }

    [Fact]
    public void TheEntryContentIsWhatWasArchived()
    {
        using var stream = Fixture();

        var entries = new RarExtractor().Extract(stream);
        var a = entries.Single(e => e.Name == "a.csv");

        Assert.Equal("id\n", Encoding.UTF8.GetString(a.Content));
    }

    [Fact]
    public void ACorruptArchiveThrowsForTheProcessorToCatch()
    {
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes("this is not a rar"));

        Assert.ThrowsAny<Exception>(() => new RarExtractor().Extract(stream));
    }

    [Fact]
    public void ExtractedEntryModifiedUtcCarriesUtcKind()
    {
        // Task 4/6/7 review requirement: SharpCompress exposes LastModifiedTime as a DateTime?, not
        // a DateTimeOffset. Measured directly against this fixture (see task-7-report.md): the value
        // comes back with Kind.Local (WinRAR records wall-clock time with no timezone, and
        // SharpCompress marks the DateTime it hands back as Local rather than Unspecified), so
        // .ToUniversalTime() correctly converts using this machine's offset and yields Kind.Utc.
        // Had the Kind instead come back Unspecified, the same call would still shift the value by
        // treating it as local time — .NET's ToUniversalTime treats Unspecified and Local
        // identically — but the Kind on the result differs from what this repo's fixtures actually
        // produce, which is why the measurement (not an assumption) decides which case this is.
        using var stream = Fixture();

        var entries = new RarExtractor().Extract(stream);

        Assert.All(entries, e => Assert.Equal(DateTimeKind.Utc, e.ModifiedUtc!.Value.Kind));
    }
}
