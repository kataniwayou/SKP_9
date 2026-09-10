using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.ArchiveExpander;
using Processor.ArchiveExpander.Extractors;
using SharpCompress.Archives.Rar;
using Xunit;

namespace BaseApi.Tests.ArchiveExpander;

/// <summary>
/// Rar, against a committed fixture. Every other extractor's test builds its archive from bytes;
/// this one cannot, because SharpCompress reads rar and cannot write one. See Fixtures/README.md for
/// how the file is regenerated.
/// </summary>
public sealed class RarExtractorTests : IDisposable
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private readonly string _dir = Directory.CreateTempSubdirectory("skp-archiveexpander-rar-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private static Stream Fixture()
        => File.OpenRead(Path.Combine(
            AppContext.BaseDirectory, "ArchiveExpander", "Fixtures", "three-entries.rar"));

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

        // RAR4 and RAR5 differ only in the seventh byte, and SharpCompress reads both.
        Assert.True(extractor.CanHandle(new byte[] { 0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00 }));
        Assert.True(extractor.CanHandle(new byte[] { 0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01 }));

        Assert.False(extractor.CanHandle(new byte[] { 0x50, 0x4B, 0x03, 0x04 }));
        Assert.False(extractor.CanHandle(new byte[] { 0x52, 0x61, 0x72 }));
        Assert.False(extractor.CanHandle(ReadOnlySpan<byte>.Empty));
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
        // THIS TEST USED TO ASSERT ThrowsAny<Exception>, AND THAT IS WHY THE SEAM FAILURE SURVIVED
        // REVIEW. Its name claims the throw is one the processor catches; ThrowsAny asserts only
        // that something was thrown, and what was actually thrown here was a SharpCompress
        // exception, which descends from SharpCompressException : Exception and matched NONE of the
        // BCL types the processor's catch list held. So an ordinary corrupt rar failed the step via
        // the framework's general catch — "the transform faulted", at Warning, with a stack trace
        // and no file path anywhere — and this test passed over it, every time.
        //
        // A test that accepts any exception cannot distinguish the outcome it is named for from the
        // outcome it exists to prevent. The seam's type is the assertion.
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes("this is not a rar"));

        Assert.Throws<ArchiveExtractionException>(() => new RarExtractor().Extract(stream));
    }

    [Fact]
    public async Task ACorruptArchiveFailsTheStepNamingThePath()
    {
        // THE PROCESSOR-LEVEL TEST RAR NEVER HAD, and the one that fails outright against the old
        // catch list. Only zip had this test; the extractor-level assertions above prove the
        // extractor throws, and prove nothing about whether the throw reaches the processor's catch
        // or escapes past it. §9 puts these checks in ProcessAsync precisely so the path is in the
        // message, so the message is what gets asserted.
        //
        // Not a truncation: an ORDINARY corrupt rar, which is the case that was broken. The two
        // truncation windows below were the only inputs that ever reached this template, because
        // they trip RarExtractor's own guard rather than SharpCompress's parser.
        var path = Path.Combine(_dir, "broken.rar");
        File.WriteAllText(path, "this is not a rar");

        var processor = new ArchiveExpanderProcessor(
            new RecordingLogger<ArchiveExpanderProcessor>(),
            Options.Create(new ArchiveExpanderOptions()),
            new FileContentBuilder([new RarExtractor()]));
        processor.BeginDispatch(
            new DispatchState(Substitute.For<IQueueSender>(), C, W, S, P));

        var ex = await Assert.ThrowsAsync<FailedException>(() => processor.ExecuteAsync(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { filePath = path })),
            """{"ExpectedExtension":".rar","MinimumSizeBytes":0,"MaximumSizeBytes":65536}""",
            E, CancellationToken.None));

        Assert.Contains($"extracting {path} failed", ex.Message, StringComparison.Ordinal);
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

        Assert.Throws<ArchiveExtractionException>(() => new RarExtractor().Extract(stream));
    }

    [Fact]
    public void ATruncatedArchiveJustPastTheMainHeaderThrowsForTheProcessorToCatch()
    {
        // The second false-HEALTHY window fix round 1 found: the fixture truncated to 23-26 bytes —
        // just past the main archive header, before the first file header — opens and enumerates to
        // zero entries with no exception, same as the signature-window case above. Measured
        // directly against this exact fixture (see task-7-fix-round-1-report.md).
        using var stream = new MemoryStream(Truncated(24));

        Assert.Throws<ArchiveExtractionException>(() => new RarExtractor().Extract(stream));
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
