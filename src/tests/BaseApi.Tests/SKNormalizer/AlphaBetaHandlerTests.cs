using System.Text;
using Microsoft.Extensions.Time.Testing;
using Processor.SKNormalizer;
using Xunit;

namespace BaseApi.Tests.SKNormalizer;

/// <summary>
/// AlphaBeta runs AFTER Acme, on Acme's output: it lifts the standardized <c>.xml</c> entry out and
/// makes it the whole document, discarding the audio and the container.
/// <para>
/// <b>The load-bearing claim is <see cref="ThePassedThroughXmlIsByteIdenticalToAcmes"/>.</b> Both
/// branches of the chain write into one folder, and a reader comparing <c>track01.xml</c> with the
/// copy inside <c>acme-&lt;guid&gt;.zip</c> must find one document. This handler renders nothing, so
/// that holds by construction rather than by two code paths being kept in step.
/// </para>
/// </summary>
public sealed class AlphaBetaHandlerTests
{
    private static DateTime Created => new(2026, 2, 1, 1, 1, 1, DateTimeKind.Utc);

    private static DateTime Stamp => new(2026, 3, 4, 5, 6, 7, DateTimeKind.Utc);

    private const string Sidecar = """
        {
          "title": "Nocturne in E-flat",
          "artist": "Unknown",
          "album": "Field Recordings",
          "recordedUtc": "2026-03-04T05:06:07Z",
          "audio": { "file": "track01.wav", "sampleRateHz": 44100, "channels": 2, "durationSeconds": 184.2 }
        }
        """;

    private static readonly byte[] Wav = [0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03, 0x04];

    private static FileNode Leaf(string name, byte[] content)
        => new(
            new FileMetadata(name, Path.GetExtension(name), content.LongLength, Created, Stamp, 0),
            new FileContent.Bytes(content));

    private static FileNode Leaf(string name, string text)
        => Leaf(name, Encoding.UTF8.GetBytes(text));

    private static FileNode Archive(string name, params FileNode[] entries)
        => new(
            new FileMetadata(name, Path.GetExtension(name), 4096, null, Stamp, entries.Length),
            new FileContent.Entries(entries));

    private static AlphaBetaHandler Handler() => new();

    private static AcmeHandler Acme()
        => new(new FakeTimeProvider(new DateTimeOffset(2026, 9, 14, 4, 31, 0, TimeSpan.Zero)));

    /// <summary>Runs the real stages in pipeline order and returns the document the assembler built.</summary>
    private static FileNode Run(FileNode root, IProviderHandler handler)
    {
        var pipeline = new NormalizationPipeline(
            new TreeAssembler(), new XmlMetadataRenderer(), new FakeTranscoder());

        return pipeline.Run(root, handler, FieldWhitelists.AdmitAll, CancellationToken.None).Document;
    }

    /// <summary>
    /// Stands in for ffmpeg where <see cref="AcmeUpstream"/> needs it, reporting what the Acme
    /// profile produces in the cluster — verified live on 2026-09-14: <c>ID3</c>-headed bytes, codec
    /// <c>mp3</c>, 192 kb/s. <b>AlphaBeta never reaches stage 6</b>, so any test running only this
    /// handler would pass with a transcoder that threw.
    /// </summary>
    private sealed class FakeTranscoder : IAudioTranscoder
    {
        public NormalizedAudio Transcode(
            byte[] content, string extension, AudioProfile profile, CancellationToken ct)
            => new([0x49, 0x44, 0x33, 0x04], profile.TargetExtension, 4,
                TimeSpan.FromSeconds(184.2), 192, "mp3");
    }

    /// <summary>
    /// THE REAL UPSTREAM, not a hand-written stand-in. Running AcmeHandler through the real pipeline
    /// is what makes these tests fail if Acme ever changes its output shape — a fixture shaped like
    /// Acme's output by hand would keep passing while the wiring broke.
    /// </summary>
    private static FileNode AcmeUpstream()
        => Run(
            Archive("acme-001.zip", Leaf("track01.wav", Wav), Leaf("track01.json", Sidecar)),
            Acme());

    private static byte[] Bytes(FileNode node) => ((FileContent.Bytes)node.Content!).Value;

    [Fact]
    public void ThePassedThroughXmlIsByteIdenticalToAcmes()
    {
        var upstream = AcmeUpstream();

        var acmesXml = Bytes(((FileContent.Entries)upstream.Content!).Value
            .Single(e => e.Metadata.Name == "track01.xml"));

        var document = Run(upstream, Handler());

        // BYTE-FOR-BYTE, not "equivalent". This handler renders nothing and copies nothing into a
        // new buffer's worth of different formatting -- whatever Acme wrote is what leaves, so the
        // file in out/ and the copy inside acme-<guid>.zip cannot disagree.
        Assert.Equal(acmesXml, Bytes(document));

        // And it really is Acme's document, mp3 measurements and all.
        var text = Encoding.UTF8.GetString(Bytes(document));
        Assert.Contains("<provider>Acme</provider>", text, StringComparison.Ordinal);
        Assert.Contains("<fileName>track01.mp3</fileName>", text, StringComparison.Ordinal);
        Assert.Contains("<codec>mp3</codec>", text, StringComparison.Ordinal);
        Assert.Contains("<bitrateKbps>192</bitrateKbps>", text, StringComparison.Ordinal);
    }

    [Fact]
    public void TheDocumentIsTheXmlItself_NoArchiveAndNoEntries()
    {
        var document = Run(AcmeUpstream(), Handler());

        // THE WHOLE POINT: a leaf root. Not a .zip holding one .xml -- ArchiveCollapser packs an
        // entries-bearing root and carries a Bytes root straight through, so this is the difference
        // between file-persister writing track01.xml and writing acme-001.zip.
        var bytes = Assert.IsType<FileContent.Bytes>(document.Content);

        Assert.Equal("track01.xml", document.Metadata.Name);
        Assert.Equal(".xml", document.Metadata.Extension);
        Assert.Equal(0, document.Metadata.EntryCount);
        Assert.Equal(bytes.Value.LongLength, document.Metadata.SizeBytes);
    }

    [Fact]
    public void TheAudioIsDiscardedRatherThanCarried()
    {
        var document = Run(AcmeUpstream(), Handler());

        // The mp3 Acme produced belongs to the other branch's archive. An .mp3 beside the XML is
        // expected input here, not a third-entry fault -- the opposite of AcmeHandler, which refuses
        // an unexpected entry because carrying one would silently drop it.
        Assert.DoesNotContain(
            "ID3", Encoding.UTF8.GetString(Bytes(document)), StringComparison.Ordinal);
        Assert.StartsWith("<?xml", Encoding.UTF8.GetString(Bytes(document)), StringComparison.Ordinal);
    }

    [Fact]
    public void TheXmlEntrysOwnTimestampsTravelWithIt()
    {
        var document = Run(AcmeUpstream(), Handler());

        // Acme writes the SIDECAR's timestamps onto the XML it emits, so these arrive from two hops
        // back and must not be replaced by the container's or by now's.
        Assert.Equal(Created, document.Metadata.CreatedUtc);
        Assert.Equal(Stamp, document.Metadata.ModifiedUtc);
    }

    [Fact]
    public void TwoStandardizedXmlsAreRefusedByName_NotSilentlyReducedToOne()
    {
        var twoPairs = Run(
            Archive("acme-002.zip",
                Leaf("track01.wav", Wav), Leaf("track01.json", Sidecar),
                Leaf("track02.wav", Wav), Leaf("track02.json", Sidecar)),
            Acme());

        var ex = Assert.Throws<NormalizationException>(() => Run(twoPairs, Handler()));

        // THE ONE DOCUMENT THE TWO BRANCHES DISAGREE ABOUT: the same bundle completes on the Acme
        // branch, which has a container to put both items in.
        Assert.Contains("it holds 2", ex.Message, StringComparison.Ordinal);
        Assert.Contains("'track01.xml'", ex.Message, StringComparison.Ordinal);
        Assert.Contains("'track02.xml'", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ADocumentWithNoStandardizedXmlIsRefused()
    {
        var ex = Assert.Throws<NormalizationException>(() => Run(
            Archive("plain.zip", Leaf("notes.txt", "nothing standardized here")), Handler()));

        Assert.Contains("it holds 0", ex.Message, StringComparison.Ordinal);
        Assert.Contains("plain.zip", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ALeafRootSaysTheStepIsWiredBehindTheWrongThing()
    {
        var ex = Assert.Throws<NormalizationException>(
            () => Handler().Locate(Leaf("song.mp3", Wav)));

        Assert.Contains("is a file rather than a document holding entries",
            ex.Message, StringComparison.Ordinal);
        Assert.Contains("song.mp3", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AnXmlEntryCarryingNothingFailsWithTheItemNamed()
    {
        var hollow = Archive("acme-003.zip",
            new FileNode(new FileMetadata("track01.xml", ".xml", 0, Created, Stamp, 0), null));

        var ex = Assert.Throws<NormalizationException>(() => Run(hollow, Handler()));

        // NormalizationPipeline prepends the key for a per-item stage; that is why this check lives
        // in ValidateContent rather than in LayoutFor.
        Assert.Contains("item 'track01':", ex.Message, StringComparison.Ordinal);
        Assert.Contains("nothing to lift", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TheMetadataStaysUnsetSoThePipelineRendersNothing()
    {
        // THE INVARIANT A FUTURE Reconcile OVERRIDE WOULD BREAK. If anything populated the metadata,
        // IsUnset would go false, the pipeline would demand every required element, and every
        // dispatch would fail on an incomplete document -- while looking like a content problem.
        var item = Assert.Single(Handler().Locate(AcmeUpstream()));

        var metadata = Handler().Map(item);
        Handler().Augment(metadata, item, FieldWhitelists.AdmitAll);
        Handler().Reconcile(metadata, null, Handler().NameFor(metadata, item));

        Assert.True(metadata.IsUnset);
    }
}
