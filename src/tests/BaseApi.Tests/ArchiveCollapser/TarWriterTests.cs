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
        // not close. Asserted through the extractor rather than by counting bytes: measured
        // separately that disposing a BclTarWriter with zero entries written produces a 0-byte
        // stream (see TarWriter.WriteCore), which satisfies the all-zero-bytes guard vacuously --
        // the test does not need to re-assert the byte count to prove the healthy branch is taken.
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
    public void APreDosPostEpochTimestampIsNotClampedBecauseTarCanRepresentIt()
    {
        // Distinguishing value, not the epoch: 1975-06-01 is below zip's 1980 DOS floor (so this
        // proves zip's clamp is genuinely absent here, not coincidentally satisfied) and above the
        // BCL's own 1970 floor (so PaxTarEntry.ModificationTime's setter accepts it unclamped). The
        // rule is "write the value the expander would read back", and tar reads back what zip could
        // not hold. Clamping here would throw away information the writer is actually able to keep.
        var stamp = new DateTime(1975, 6, 1, 0, 0, 0, DateTimeKind.Utc);

        var bytes = new TarWriter().Write([Entry("a.csv", "id", stamp)]);

        Assert.Equal(stamp, Assert.Single(ReadBack(bytes)).ModifiedUtc);
    }

    [Fact]
    public void APreEpochTimestampIsClampedBecauseTheBclWriterCannotRepresentIt()
    {
        // Reachable, not theoretical: a hand-built PAX tar carrying a negative mtime extended record
        // (GNU tar's own encoding for a pre-1970 file) reads back through the real TarReader as
        // 1969-12-31T00:00:00Z with no exception -- so ArchiveExpander can and does hand this writer
        // a below-epoch ModifiedUtc. PaxTarEntry.ModificationTime's setter throws
        // ArgumentOutOfRangeException for anything before DateTimeOffset.UnixEpoch (measured; see
        // TarWriter.WriteCore), so this is a .NET WRITER bound, not a tar FORMAT bound -- refusing to
        // write here would lose the timestamp AND the whole archive, where clamping loses only the
        // timestamp. The clamp lands on the epoch, which is exactly what TarExtractor reads back,
        // keeping "write the value the expander would read back" true even at this boundary.
        var stamp = new DateTime(1969, 12, 31, 0, 0, 0, DateTimeKind.Utc);

        var bytes = new TarWriter().Write([Entry("a.csv", "id", stamp)]);

        Assert.Equal(
            new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc),
            Assert.Single(ReadBack(bytes)).ModifiedUtc);
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
