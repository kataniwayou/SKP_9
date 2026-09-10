using System.Text;
using Processor.ArchiveCollapser.Writers;
using Processor.ArchiveExpander.Extractors;
using Xunit;

namespace BaseApi.Tests.ArchiveCollapser;

public sealed class TarWriterTests
{
    private static ArchiveEntry Entry(string name, string text, DateTime? stamp = null)
        => new(name, Encoding.UTF8.GetBytes(text), stamp);

    private static IReadOnlyList<ExtractedEntry> ReadBack(byte[] archive)
    {
        using var stream = new MemoryStream(archive, writable: false);
        return new TarExtractor().Extract(stream);
    }

    [Fact]
    public void EntriesSurviveARoundTripThroughTheRealExtractor()
    {
        var bytes = new TarWriter().Write([Entry("a.csv", "id"), Entry("b.csv", "id,name")]);

        var read = ReadBack(bytes);

        Assert.Equal(["a.csv", "b.csv"], read.Select(e => e.Name).ToArray());
        Assert.Equal("id,name", Encoding.UTF8.GetString(read[1].Content));
    }

    [Fact]
    public void TheArchiveCarriesTheUstarMagicTheExtractorRequires()
    {
        // TarExtractor.CanHandle looks for "ustar" at byte 257 and explicitly refuses pre-POSIX V7.
        // Writing V7 would produce a tar OUR OWN expander cannot recognise -- it would be treated as
        // a leaf and the round trip would silently break. This is why the format is Pax and not a
        // matter of taste.
        var bytes = new TarWriter().Write([Entry("a.csv", "id")]);

        Assert.True(new TarExtractor().CanHandle(bytes));
    }

    [Fact]
    public void AnEmptyListProducesAnArchiveTheExtractorCallsHealthy()
    {
        // TarExtractor treats "no entries" as corrupt UNLESS the archive is all zero bytes. A
        // document with content:null must land on the healthy side of that guard, or the loop does
        // not close. Asserted through the extractor rather than by counting bytes, because whether
        // the BCL writes trailing zero blocks or nothing at all is unmeasured -- and both satisfy
        // the guard, so the test does not need to care which.
        var bytes = new TarWriter().Write([]);

        Assert.Empty(ReadBack(bytes));
    }

    [Fact]
    public void AModifiedTimestampSurvivesTheRoundTripExactly()
    {
        var stamp = new DateTime(2026, 6, 7, 8, 9, 11, DateTimeKind.Utc);

        var bytes = new TarWriter().Write([Entry("a.csv", "id", stamp)]);

        // Odd second on purpose: Pax stores full precision where zip rounds to two seconds, and
        // this is the assertion of that difference.
        Assert.Equal(stamp, Assert.Single(ReadBack(bytes)).ModifiedUtc);
    }

    [Fact]
    public void APreDosTimestampIsNotClampedBecauseTarCanRepresentIt()
    {
        // The rule is "write the value the expander would read back", and tar reads back what zip
        // could not hold. Clamping here would throw away information the format keeps.
        var stamp = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        var bytes = new TarWriter().Write([Entry("a.csv", "id", stamp)]);

        Assert.Equal(stamp, Assert.Single(ReadBack(bytes)).ModifiedUtc);
    }

    [Fact]
    public void ANullTimestampBecomesTheUnixEpoch()
    {
        // Tar has no null. The epoch is tar's own conventional zero and is what TarExtractor reads
        // back, which keeps the fixed point.
        var bytes = new TarWriter().Write([Entry("a.csv", "id", null)]);

        Assert.Equal(
            new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc),
            Assert.Single(ReadBack(bytes)).ModifiedUtc);
    }
}
