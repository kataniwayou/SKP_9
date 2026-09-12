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
    public void LocateOrdersTheAudioAheadOfTheSidecar()
    {
        // §14 leaves "which node is the audio" to a convention, and the pipeline's stage 6 resolves
        // it as Nodes.FirstOrDefault(n => n.Content is FileContent.Bytes) -- the FIRST node. Most zip
        // writers emit entries alphabetically, so track01.json arrives before track01.wav; a clone of
        // this handler that adds a ProfileFor and inherits this Locate would hand ffmpeg the SIDECAR.
        // Nothing here converts, so this is invisible at runtime today -- hence the test.
        var item = Assert.Single(
            Handler().Locate(Archive(Leaf("track01.json", Sidecar), Leaf("track01.wav", Wav))));

        Assert.Equal("track01.wav", item.Nodes[0].Metadata.Name);
        Assert.Equal("track01.json", item.Nodes[1].Metadata.Name);
    }

    [Fact]
    public void AnArchiveThatExpandedToNothingYieldsNoItems()
    {
        // REACHABLE, AND DELIBERATELY KEPT. FileNode.Content is nullable and ArchiveExpander writes
        // content: null for an archive with no entries, so `is not FileContent.Entries` is true for
        // a perfectly ordinary empty zip. A previous review called this branch dead by counting
        // FileContent's two variants and forgetting the null; empty in, empty out is correct, and
        // only a LEAF root can lose content by returning no items.
        var empty = new FileNode(new FileMetadata("bundle.zip", ".zip", 22, null, Stamp, 0), null);

        Assert.Empty(Handler().Locate(empty));
    }

    [Fact]
    public void AnAudioNodeCarryingNoContentIsRejected()
    {
        // Counting by extension is not enough: the expander can emit a node with null content, and
        // stage 8 emits the audio entry unconditionally. Caught here it is a named failed step;
        // uncaught it was a file silently missing from the output beside its XML.
        var handler = Handler();
        var contentless = new FileNode(
            new FileMetadata("track01.wav", ".wav", 0, null, Stamp, 0), null);

        var item = Assert.Single(handler.Locate(Archive(contentless, Leaf("track01.json", Sidecar))));

        var ex = Assert.Throws<NormalizationException>(() => handler.ValidateContent(item));

        Assert.Equal("the .wav audio file carries no content", ex.Message);
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
    public void TheMetadataFileIsRenamedToXmlAndTheAudioToMp3()
    {
        var handler = Handler();
        var item = Assert.Single(handler.Locate(
            Archive(Leaf("track01.wav", Wav), Leaf("track01.json", Sidecar))));

        var names = handler.NameFor(handler.Map(item), item);

        Assert.Equal("track01.xml", names.MetadataFileName);

        // NOT track01.wav. Stage 6 replaces the bytes, so keeping the source name would put mp3
        // content in a .wav entry with the XML's <codec> asserting mp3 beside it.
        Assert.Equal("track01.mp3", names.AudioFileName);
    }

    [Fact]
    public void TheAudioIsTranscodedToMp3()
    {
        // The codec is asserted, not just the extension: ffmpeg picks an mp3 encoder for a .mp3
        // output on its own, and which one depends on how the binary in the image was built.
        var handler = Handler();
        var item = Assert.Single(handler.Locate(
            Archive(Leaf("track01.wav", Wav), Leaf("track01.json", Sidecar))));

        var profile = Assert.IsType<AudioProfile>(handler.ProfileFor(item));

        Assert.Equal(".mp3", profile.TargetExtension);
        Assert.Equal(["-c:a", "libmp3lame", "-b:a", "192k"], profile.Arguments);
    }

    [Fact]
    public void TheProfileResamplesNothing()
    {
        // Map copies the sidecar's sampleRateHz and channels into the metadata and Reconcile
        // corrects neither, so an -ar or -ac here would publish two claims about the output that
        // nothing measured. This test is the guard on that reasoning, not on ffmpeg's syntax.
        var handler = Handler();
        var item = Assert.Single(handler.Locate(
            Archive(Leaf("track01.wav", Wav), Leaf("track01.json", Sidecar))));

        var profile = Assert.IsType<AudioProfile>(handler.ProfileFor(item));

        Assert.DoesNotContain("-ar", profile.Arguments);
        Assert.DoesNotContain("-ac", profile.Arguments);
    }

    [Fact]
    public void LayoutForEmitsTheAudioAndTheRenderedXmlInPlaceOfTheJson()
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

        // Named for the conversion by stage 5; carrying the source bytes because this call passes
        // a null NormalizedAudio -- the arm exercised in full by
        // LayoutForFallsBackToTheSourceBytesWhenNothingWasConverted below.
        var audio = Assert.IsType<OutputNode.File>(children.Single(c => c is OutputNode.File { Name: "track01.mp3" }));
        Assert.Equal(Wav, audio.Content);

        var xml = Assert.IsType<OutputNode.File>(children.Single(c => c is OutputNode.File { Name: "track01.xml" }));
        Assert.Equal(document, xml.Content);
    }

    [Fact]
    public void LayoutForEmitsTheConvertedAudioRatherThanTheSourceBytes()
    {
        // THE DEFECT THIS TEST EXISTS FOR, and it is no longer hypothetical: ProfileFor names an
        // mp3 profile, so the pipeline transcodes, Reconcile writes the MEASURED codec and bitrate
        // into the XML, and -- until this was fixed -- LayoutFor wrote the ORIGINAL wav bytes into
        // an entry named track01.mp3. The extension, <codec> and <bitrateKbps> would all lie about
        // the content, nothing would fail, and the collapser would pack it happily.
        var handler = Handler();
        var root = Archive(Leaf("track01.wav", Wav), Leaf("track01.json", Sidecar));
        var item = Assert.Single(handler.Locate(root));

        var metadata = handler.Map(item);
        handler.Augment(metadata, item);

        // What a converting clone would produce: stage 5 names the entry for the target format and
        // stage 6 hands back the bytes in it.
        var names = new ItemNames("track01.xml", "track01.mp3");
        var mp3 = Encoding.UTF8.GetBytes("transcoded-mp3-bytes");
        var converted = new NormalizedAudio(
            mp3, ".mp3", mp3.LongLength, TimeSpan.FromSeconds(184), 192, "mp3");

        var layout = handler.LayoutFor(
            root,
            [new NormalizedItem(item, metadata, names, converted, Encoding.UTF8.GetBytes("<metadata />"))]);

        var children = Assert.IsType<OutputNode.Folder>(layout.Root).Children!;
        var audio = Assert.IsType<OutputNode.File>(
            children.Single(c => c is OutputNode.File { Name: "track01.mp3" }));

        Assert.Equal(mp3, audio.Content);
        Assert.NotEqual(Wav, audio.Content);
    }

    [Fact]
    public void LayoutForFallsBackToTheSourceBytesWhenNothingWasConverted()
    {
        // The other arm. It is no longer this handler's own -- ProfileFor always names a profile
        // now -- but it stays covered for the metadata-only clone that inherits this LayoutFor, and
        // because a null NormalizedItem.Audio must never make the audio entry vanish.
        var handler = Handler();
        var root = Archive(Leaf("track01.wav", Wav), Leaf("track01.json", Sidecar));
        var item = Assert.Single(handler.Locate(root));

        var metadata = handler.Map(item);
        handler.Augment(metadata, item);
        var names = handler.NameFor(metadata, item);

        var layout = handler.LayoutFor(
            root, [new NormalizedItem(item, metadata, names, null, Encoding.UTF8.GetBytes("<metadata />"))]);

        var children = Assert.IsType<OutputNode.Folder>(layout.Root).Children!;
        var audio = Assert.IsType<OutputNode.File>(
            children.Single(c => c is OutputNode.File { Name: "track01.mp3" }));

        Assert.Equal(Wav, audio.Content);
    }
}
