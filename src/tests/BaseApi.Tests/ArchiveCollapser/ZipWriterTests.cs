using System.Text;
using Processor.ArchiveCollapser.Writers;
using Processor.ArchiveExpander.Extractors;
using Xunit;

namespace BaseApi.Tests.ArchiveCollapser;

/// <summary>
/// The writer, asserted THROUGH THE REAL EXTRACTOR wherever possible. Asserting on archive bytes
/// directly would pin this runtime's deflate output, which is not a contract; asserting that
/// ArchiveExpander reads back what we wrote is the property that actually matters.
/// </summary>
public sealed class ZipWriterTests
{
    private static ArchiveEntry Entry(string name, string text, DateTime? stamp = null)
        => new(name, Encoding.UTF8.GetBytes(text), stamp);

    private static IReadOnlyList<ExtractedEntry> ReadBack(byte[] archive)
    {
        using var stream = new MemoryStream(archive, writable: false);
        return new ZipExtractor().Extract(stream);
    }

    [Fact]
    public void EntriesSurviveARoundTripThroughTheRealExtractor()
    {
        var bytes = new ZipWriter().Write(
            [Entry("a.csv", "id"), Entry("b.csv", "id,name")]);

        var read = ReadBack(bytes);

        Assert.Equal(["a.csv", "b.csv"], read.Select(e => e.Name).ToArray());
        Assert.Equal("id,name", Encoding.UTF8.GetString(read[1].Content));
    }

    [Fact]
    public void AnEmptyListProducesTheCanonicalEmptyArchive()
    {
        // 22 bytes: a bare End Of Central Directory record. This is the ONE zip that legitimately
        // yields nothing, and ZipExtractor.IsCanonicalEmptyArchive exists to recognise exactly it.
        // Anything else here means a document with content:null collapses to something the expander
        // will call corrupt -- the loop would not close.
        var bytes = new ZipWriter().Write([]);

        Assert.Equal(22, bytes.Length);
        Assert.Empty(ReadBack(bytes));
    }

    [Fact]
    public void AModifiedTimestampSurvivesTheRoundTripExactly()
    {
        // THE FIXED POINT, AT ONE ENTRY. This is the assertion the whole timestamp rule rests on,
        // and it must be written as a ROUND TRIP rather than against a literal -- ZipArchiveEntry
        // stores DOS wall-clock time and its getter and setter do not agree about the offset, so a
        // naive `new DateTimeOffset(utc)` can round-trip correctly on a UTC machine and be wrong by
        // the local offset everywhere else. A literal assertion would hide that; this cannot.
        var stamp = new DateTime(2026, 6, 7, 8, 9, 10, DateTimeKind.Utc);

        var bytes = new ZipWriter().Write([Entry("a.csv", "id", stamp)]);

        // Zip stores 2-second resolution, so an odd second rounds. Chosen even to avoid it.
        Assert.Equal(stamp, Assert.Single(ReadBack(bytes)).ModifiedUtc);
    }

    [Theory]
    [InlineData(null)]                 // the rar case: the document recorded no timestamp
    [InlineData("1970-01-01T00:00:00Z")] // the tar case: legal in tar, below the DOS floor
    [InlineData("1900-01-01T00:00:00Z")]
    public void ATimestampBelowTheDosFloorClampsToTheFloorTheExtractorReportsBack(string? iso)
    {
        // The rule is "write the value the expander would read back", so the assertion is that the
        // extractor reports the floor -- not that some internal method returned it.
        DateTime? stamp = iso is null ? null : DateTime.Parse(iso).ToUniversalTime();

        var bytes = new ZipWriter().Write([Entry("a.csv", "id", stamp)]);

        Assert.Equal(
            new DateTime(1980, 1, 1, 0, 0, 0, DateTimeKind.Utc),
            Assert.Single(ReadBack(bytes)).ModifiedUtc);
    }

    [Fact]
    public void ATimestampAboveTheDosCeilingClampsRatherThanThrowing()
    {
        // The other end of the DOS range. Without a clamp this throws ArgumentOutOfRangeException
        // out of LastWriteTime, which -- being an ArgumentException -- would surface as an
        // ArchiveWritingException and a failed step over a document that is merely optimistic.
        var bytes = new ZipWriter().Write(
            [Entry("a.csv", "id", new DateTime(2200, 1, 1, 0, 0, 0, DateTimeKind.Utc))]);

        Assert.True(Assert.Single(ReadBack(bytes)).ModifiedUtc!.Value.Year <= 2107);
    }

    [Fact]
    public void ClampingIsAFixedPointAcrossASecondPass()
    {
        // Write a clamped value, read it, write it again: the second archive must carry the same
        // timestamp as the first. This is what makes "collapse -> expand is a fixed point" true
        // rather than aspirational.
        var writer = new ZipWriter();

        var first = writer.Write([Entry("a.csv", "id", null)]);
        var afterOne = Assert.Single(ReadBack(first)).ModifiedUtc;

        var second = writer.Write([Entry("a.csv", "id", afterOne)]);
        var afterTwo = Assert.Single(ReadBack(second)).ModifiedUtc;

        Assert.Equal(afterOne, afterTwo);
    }
}
