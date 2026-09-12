using System.Text;
using Microsoft.Extensions.Time.Testing;
using Processor.SKNormalizer;
using Xunit;

namespace BaseApi.Tests.SKNormalizer;

public sealed class AcmeHandlerTests
{
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

    private static FileNode Leaf(string name, byte[] content)
        => new(
            new FileMetadata(name, Path.GetExtension(name), content.LongLength, null, Stamp, 0),
            new FileContent.Bytes(content));

    private static FileNode Leaf(string name, string text)
        => Leaf(name, Encoding.UTF8.GetBytes(text));

    private static FileNode Archive(params FileNode[] entries)
        => new(
            new FileMetadata("bundle.zip", ".zip", 4096, null, Stamp, entries.Length),
            new FileContent.Entries(entries));

    private static AcmeHandler Handler()
        => new(new FakeTimeProvider(new DateTimeOffset(2026, 9, 12, 4, 31, 0, TimeSpan.Zero)));

    private static readonly byte[] Wav = [0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03, 0x04];

    [Fact]
    public void LocatePairsTheAudioAndItsSidecarIntoOneItem()
    {
        var item = Assert.Single(
            Handler().Locate(Archive(Leaf("track01.wav", Wav), Leaf("track01.json", Sidecar))));

        Assert.Equal(2, item.Nodes.Count);
    }

    [Fact]
    public void AnItemMissingItsSidecarIsRejectedByName()
    {
        // The operator's whole diagnostic: a document of forty items whose ninth is malformed is
        // useless unless the message says which. THE KEY IS NOT ASSERTED HERE, because the handler
        // does not put it there -- NormalizationPipeline prepends "item '{key}': " to every stage
        // failure, uniformly across handlers, and repeating it in the handler read as
        // "item 'track01': item 'track01': ...". What this pins is the reason text.
        var handler = Handler();
        var item = Assert.Single(handler.Locate(Archive(Leaf("track01.wav", Wav))));

        var ex = Assert.Throws<NormalizationException>(() => handler.ValidateContent(item));

        Assert.Equal(
            "an Acme item needs exactly one .wav and one .json, and this one holds 1 and 0",
            ex.Message);
    }

    [Fact]
    public void AnItemCarryingAnUnexpectedThirdEntryIsRejectedAndTheEntryIsNamed()
    {
        // LayoutFor emits one audio and one XML per item, so a third file sharing the basename
        // would vanish from the output with nothing failing. Silent loss, so it is a failed step.
        var handler = Handler();
        var item = Assert.Single(handler.Locate(Archive(
            Leaf("track01.wav", Wav), Leaf("track01.json", Sidecar), Leaf("track01.txt", "notes"))));

        var ex = Assert.Throws<NormalizationException>(() => handler.ValidateContent(item));

        Assert.Equal(
            "an Acme item is exactly the .wav and the .json, and this one also holds track01.txt",
            ex.Message);
    }

    [Fact]
    public void ALeafRootIsRejectedRatherThanSilentlyBecomingAnEmptyArchive()
    {
        // Returning no items here would send an empty list into LayoutFor, which builds a childless
        // Folder, which the assembler emits as content: null -- the document's bytes destroyed with
        // no failed step. That is the defect OutputLayout was reshaped to prevent, and a handler
        // must not reintroduce it.
        var handler = Handler();

        var ex = Assert.Throws<NormalizationException>(() => handler.Locate(Leaf("song.mp3", Wav)));

        Assert.Contains("song.mp3", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AnItemMissingItsAudioIsRejected()
    {
        var handler = Handler();
        var item = Assert.Single(handler.Locate(Archive(Leaf("track01.json", Sidecar))));

        Assert.Throws<NormalizationException>(() => handler.ValidateContent(item));
    }

    [Fact]
    public void MalformedJsonIsABusinessFailureThatDoesNotQuoteTheContent()
    {
        // The parse error quotes the fragment that failed, and that fragment is upstream content --
        // it must not reach a log store, and a FailedException message IS logged verbatim.
        var handler = Handler();
        var item = Assert.Single(handler.Locate(
            Archive(Leaf("track01.wav", Wav), Leaf("track01.json", """{"title":"secret-value"""))));

        var ex = Assert.Throws<NormalizationException>(() => handler.Map(item));

        // EQUALITY, NOT AN ABSENCE. System.Text.Json's own message for this exact input happens not
        // to contain "secret-value" -- it reads "Expected end of string, but instead reached end of
        // data. Path: $.title | ..." -- so a DoesNotContain assertion would stay green if someone
        // appended ex.Message. Pinning the whole string is what makes the no-content rule hold for
        // every input, and for every handler copied from this one.
        Assert.Equal("the metadata sidecar is not valid JSON", ex.Message);
    }

    [Fact]
    public void MapProjectsEveryDescriptiveFieldAndTheProviderStatedAudioFacts()
    {
        var handler = Handler();
        var item = Assert.Single(handler.Locate(
            Archive(Leaf("track01.wav", Wav), Leaf("track01.json", Sidecar))));

        var metadata = handler.Map(item);

        Assert.Equal("Nocturne in E-flat", metadata.Title);
        Assert.Equal("Unknown", metadata.Artist);
        Assert.Equal("Field Recordings", metadata.Album);
        Assert.Equal(new DateTimeOffset(2026, 3, 4, 5, 6, 7, TimeSpan.Zero), metadata.RecordedUtc);
        Assert.Equal(44100, metadata.SampleRateHz);
        Assert.Equal(2, metadata.Channels);
        Assert.Equal(184.2, metadata.DurationSeconds);
        // The name of the file it was mapped FROM -- provenance, not the audio.
        Assert.Equal("track01.json", metadata.OriginalName);
    }

    [Fact]
    public void AugmentSuppliesTheProviderConstantAndTheIngestTime()
    {
        var handler = Handler();
        var item = Assert.Single(handler.Locate(
            Archive(Leaf("track01.wav", Wav), Leaf("track01.json", Sidecar))));

        var metadata = handler.Map(item);
        handler.Augment(metadata, item);

        Assert.Equal("Acme", metadata.Provider);
        Assert.Equal(new DateTimeOffset(2026, 9, 12, 4, 31, 0, TimeSpan.Zero), metadata.IngestedUtc);
    }

    [Fact]
    public void TheMetadataIsCompleteAfterMapAndAugment()
    {
        // The pipeline throws on an incomplete document. This is the assertion that the handler
        // actually fills every required element rather than most of them.
        var handler = Handler();
        var item = Assert.Single(handler.Locate(
            Archive(Leaf("track01.wav", Wav), Leaf("track01.json", Sidecar))));

        var metadata = handler.Map(item);
        handler.Augment(metadata, item);
        handler.Reconcile(metadata, null, handler.NameFor(metadata, item));

        Assert.Empty(metadata.MissingRequired());
    }

    [Fact]
    public void ReconcileReplacesTheProvidersEncodingClaimsButKeepsItsDuration()
    {
        // The branch no shipped handler reaches yet -- AcmeHandler converts nothing -- but this is
        // the handler the first converting one will be copied from, so the rule is pinned here.
        var handler = Handler();
        var item = Assert.Single(handler.Locate(
            Archive(Leaf("track01.wav", Wav), Leaf("track01.json", Sidecar))));

        var metadata = handler.Map(item);
        handler.Augment(metadata, item);

        // The sidecar claims 184.2s; it states no codec or bitrate.
        metadata.Codec = "pcm_s16le";
        metadata.BitrateKbps = 1411;

        // A conversion that produced a codec but whose probe read no duration or bitrate.
        handler.Reconcile(
            metadata,
            new NormalizedAudio([1, 2, 3], ".mp3", 3, Duration: null, BitrateKbps: null, Codec: "mp3"),
            handler.NameFor(metadata, item));

        Assert.Equal("mp3", metadata.Codec);
        Assert.Null(metadata.BitrateKbps);
        Assert.Equal(184.2, metadata.DurationSeconds);
    }

    [Fact]
    public void TheMetadataFileIsRenamedToXmlAndTheAudioKeepsItsName()
    {
        var handler = Handler();
        var item = Assert.Single(handler.Locate(
            Archive(Leaf("track01.wav", Wav), Leaf("track01.json", Sidecar))));

        var names = handler.NameFor(handler.Map(item), item);

        Assert.Equal("track01.xml", names.MetadataFileName);
        Assert.Equal("track01.wav", names.AudioFileName);
    }

    [Fact]
    public void NothingIsTranscoded()
    {
        // The wav passes through untouched, which is why §14's open question -- which node is the
        // audio -- cannot be answered by accident here: the pipeline's guess never fires.
        var handler = Handler();
        var item = Assert.Single(handler.Locate(
            Archive(Leaf("track01.wav", Wav), Leaf("track01.json", Sidecar))));

        Assert.Null(handler.ProfileFor(item));
    }

    [Fact]
    public void LayoutForEmitsTheAudioUnchangedAndTheRenderedXmlInPlaceOfTheJson()
    {
        var handler = Handler();
        var root = Archive(Leaf("track01.wav", Wav), Leaf("track01.json", Sidecar));
        var item = Assert.Single(handler.Locate(root));

        var metadata = handler.Map(item);
        handler.Augment(metadata, item);
        var names = handler.NameFor(metadata, item);
        var document = Encoding.UTF8.GetBytes("<metadata />");

        var layout = handler.LayoutFor(root, [new NormalizedItem(item, metadata, names, null, document)]);

        Assert.Equal(".zip", layout.Root is OutputNode.Folder f ? f.ArchiveExtension : null);

        var children = Assert.IsType<OutputNode.Folder>(layout.Root).Children!;
        Assert.Equal(2, children.Count);

        var audio = Assert.IsType<OutputNode.File>(children.Single(c => c is OutputNode.File { Name: "track01.wav" }));
        Assert.Equal(Wav, audio.Content);

        var xml = Assert.IsType<OutputNode.File>(children.Single(c => c is OutputNode.File { Name: "track01.xml" }));
        Assert.Equal(document, xml.Content);
    }
}
