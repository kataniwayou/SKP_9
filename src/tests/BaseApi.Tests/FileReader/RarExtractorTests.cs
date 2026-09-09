using System.Text;
using Processor.FileReader.Extractors;
using SharpCompress.Archives.Rar;
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

    /// <summary>The fixture's first <paramref name="length"/> bytes — the real archive, cut short.</summary>
    private static byte[] Truncated(int length)
    {
        using var full = Fixture();
        var buffer = new byte[length];
        var read = full.Read(buffer, 0, length);
        return read == length ? buffer : buffer[..read];
    }

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
    public void ATruncatedArchiveJustPastTheSignatureThrowsForTheProcessorToCatch()
    {
        // The false-HEALTHY window fix round 1 found: RarArchive.Open succeeds and Entries
        // enumerates to zero with NO exception for the real fixture truncated to 8-11 bytes — just
        // past the RAR5 signature, before the main archive header is complete. Measured directly
        // against this exact fixture (see task-7-fix-round-1-report.md) before adding the guard in
        // RarExtractor. Without the raw-entry-count guard, this reads as a healthy empty archive
        // rather than the truncated one it is — the same class of result Task 6 found in TarReader.
        using var stream = new MemoryStream(Truncated(10));

        Assert.Throws<InvalidDataException>(() => new RarExtractor().Extract(stream));
    }

    [Fact]
    public void ATruncatedArchiveJustPastTheMainHeaderThrowsForTheProcessorToCatch()
    {
        // The second false-HEALTHY window fix round 1 found: the fixture truncated to 23-26 bytes —
        // just past the main archive header, before the first file header — opens and enumerates to
        // zero entries with no exception, same as the signature-window case above. Measured
        // directly against this exact fixture (see task-7-fix-round-1-report.md).
        using var stream = new MemoryStream(Truncated(24));

        Assert.Throws<InvalidDataException>(() => new RarExtractor().Extract(stream));
    }

    [Fact]
    public void SharpCompressReportsLastModifiedTimeAsLocalKind()
    {
        // A canary on a library assumption, not a guard on RarExtractor's own output.
        // DateTime.ToUniversalTime() returns Kind.Utc unconditionally by .NET contract, regardless
        // of what Kind the input carried — so asserting the *output* Kind (the test below this one)
        // is true for every possible thing SharpCompress could hand back, and cannot detect the
        // change that actually matters. This test pins the input side instead: SharpCompress must
        // keep reporting LastModifiedTime as Kind.Local for RarExtractor's bare .ToUniversalTime()
        // call to remain correct. If a future SharpCompress version started returning an
        // already-correct UTC value labelled Local or Unspecified — plausible for RAR5's
        // UTC-flagged extended-time field, which this WinRAR-produced fixture does not exercise —
        // .ToUniversalTime() would silently double-shift it while still landing on Kind.Utc, and
        // the test below would keep passing over a wrong value. A failure HERE means
        // RarExtractor's conversion must be re-derived against whatever Kind SharpCompress now
        // reports — it does not mean this assertion should be relaxed to match.
        using var stream = Fixture();
        using var rar = RarArchive.Open(stream);

        Assert.All(rar.Entries, e => Assert.Equal(DateTimeKind.Local, e.LastModifiedTime!.Value.Kind));
    }

    [Fact]
    public void ExtractedEntryModifiedUtcCarriesUtcKind()
    {
        // Task 4/6/7 review requirement: SharpCompress exposes LastModifiedTime as a DateTime?, not
        // a DateTimeOffset. Measured directly against this fixture (see task-7-report.md): the value
        // comes back with Kind.Local (WinRAR records wall-clock time with no timezone, and
        // SharpCompress marks the DateTime it hands back as Local rather than Unspecified), so
        // .ToUniversalTime() correctly converts using this machine's offset and yields Kind.Utc.
        //
        // This assertion alone cannot regress-test the SharpCompress-side assumption —
        // .ToUniversalTime() always returns Kind.Utc no matter what Kind it was given, so this test
        // is documentation of the intended output shape, not a guard. The guard on the input
        // assumption is SharpCompressReportsLastModifiedTimeAsLocalKind, above.
        using var stream = Fixture();

        var entries = new RarExtractor().Extract(stream);

        Assert.All(entries, e => Assert.Equal(DateTimeKind.Utc, e.ModifiedUtc!.Value.Kind));
    }
}
