using System.Text;
using BaseApi.Tests.Support;
using Processor.SKNormalizer;
using Xunit;

namespace BaseApi.Tests.SKNormalizer;

public sealed class NormalizationPipelineTests
{
    private static DateTime Stamp => new(2026, 6, 7, 8, 9, 10, DateTimeKind.Utc);

    private static FileNode Leaf(string name, string text)
        => new(
            new FileMetadata(name, Path.GetExtension(name), text.Length, null, Stamp, 0),
            new FileContent.Bytes(Encoding.UTF8.GetBytes(text)));

    private static FileNode Archive(string name, params FileNode[] entries)
        => new(
            new FileMetadata(name, Path.GetExtension(name), 0, null, Stamp, entries.Length),
            new FileContent.Entries(entries));

    /// <summary>Records the order stages ran in, and can be told to throw from any one of them.</summary>
    private sealed class RecordingHandler : ProviderHandlerBase
    {
        public override string Name => "Recording";

        public List<string> Stages { get; } = [];

        public string? ThrowFrom { get; init; }

        public AudioProfile? Profile { get; init; }

        /// <summary>
        /// Which of the three states <see cref="Map"/> leaves the metadata in. The default is
        /// COMPLETE, which is why the incomplete arm of the pipeline's tri-state was unreachable
        /// from this file and could be deleted without a single test noticing.
        /// </summary>
        public MetadataShape Shape { get; init; } = MetadataShape.Complete;

        /// <summary>What stage 7 was handed, so a test can assert it saw the conversion's output.</summary>
        public NormalizedAudio? ReconciledAudio { get; private set; }

        /// <summary>What stage 8 was handed, so a test can read each item's MetadataDocument.</summary>
        public IReadOnlyList<NormalizedItem> LaidOut { get; private set; } = [];

        private void Enter(string stage)
        {
            Stages.Add(stage);

            if (ThrowFrom == stage)
            {
                throw new NormalizationException($"{stage} refused it");
            }
        }

        public override IReadOnlyList<SourceItem> Locate(FileNode root)
        {
            Enter(nameof(Locate));

            return root.Content is FileContent.Entries entries
                ? entries.Value.Select(e => new SourceItem(e.Metadata.Name, [e])).ToList()
                : [new SourceItem(root.Metadata.Name, [root])];
        }

        public override void ValidateContent(SourceItem item) => Enter(nameof(ValidateContent));

        public override StandardMetadata Map(SourceItem item)
        {
            Enter(nameof(Map));

            return Shape switch
            {
                // Nothing populated at all: the identity handler's shape.
                MetadataShape.Unset => new StandardMetadata(),

                // SOME of it populated, two required elements left unset. A handler bug, and the
                // pipeline must name the elements rather than emit a quietly different document.
                MetadataShape.Incomplete => new StandardMetadata
                {
                    Provider = "Recording",
                    IngestedUtc = new DateTimeOffset(2026, 9, 12, 4, 31, 0, TimeSpan.Zero),
                    Title = item.Key,
                },

                _ => new StandardMetadata
                {
                    Provider = "Recording",
                    OriginalName = item.Key,
                    IngestedUtc = new DateTimeOffset(2026, 9, 12, 4, 31, 0, TimeSpan.Zero),
                    Title = item.Key,
                    AudioFileName = item.Key,
                },
            };
        }

        public override void Augment(
            StandardMetadata metadata, SourceItem item, IFieldWhitelist whitelist)
            => Enter(nameof(Augment));

        public override ItemNames NameFor(StandardMetadata metadata, SourceItem item)
        {
            Enter(nameof(NameFor));
            return new ItemNames($"{item.Key}.xml", $"{item.Key}.mp3");
        }

        public override AudioProfile? ProfileFor(SourceItem item)
        {
            Enter(nameof(ProfileFor));
            return Profile;
        }

        public override void Reconcile(
            StandardMetadata metadata, NormalizedAudio? audio, ItemNames names)
        {
            Enter(nameof(Reconcile));

            ReconciledAudio = audio;

            if (audio?.Duration is { } duration)
            {
                metadata.DurationSeconds = duration.TotalSeconds;
            }
        }

        public override OutputLayout LayoutFor(FileNode root, IReadOnlyList<NormalizedItem> items)
        {
            Enter(nameof(LayoutFor));
            LaidOut = items;
            return base.LayoutFor(root, items);
        }
    }

    /// <summary>The three states of the pipeline's artifact decision, as a fake can produce them.</summary>
    private enum MetadataShape
    {
        Unset,
        Incomplete,
        Complete,
    }

    private static NormalizationPipeline Pipeline(IAudioTranscoder transcoder)
        => new(new TreeAssembler(), new XmlMetadataRenderer(), transcoder);

    [Fact]
    public void TheStagesRunInTheDocumentedOrder()
    {
        var handler = new RecordingHandler { Profile = new AudioProfile(".mp3", ["-b:a", "192k"]) };

        Pipeline(new FakeTranscoder()).Run(
            Archive("in.zip", Leaf("a.wav", "x")), handler, FieldWhitelists.AdmitAll, CancellationToken.None);

        Assert.Equal(
            [
                nameof(handler.Locate),
                nameof(handler.ValidateContent),
                nameof(handler.Map),
                nameof(handler.Augment),
                nameof(handler.NameFor),
                nameof(handler.ProfileFor),
                nameof(handler.Reconcile),
                nameof(handler.LayoutFor),
            ],
            handler.Stages);
    }

    [Fact]
    public void ReconcileIsHandedTheAudioTheTranscoderProduced()
    {
        // THE WHOLE REASON STAGE 7 EXISTS: duration is knowable nowhere before conversion. An
        // earlier version of this test asserted only ConvertedCount, which the pipeline increments
        // BEFORE Reconcile runs -- so it passed just as happily against an implementation calling
        // Reconcile(metadata, null, names), which is the one thing stage 7 must never see.
        var handler = new RecordingHandler { Profile = new AudioProfile(".mp3", []) };

        var result = Pipeline(new FakeTranscoder()).Run(
            Archive("in.zip", Leaf("a.wav", "x")), handler, FieldWhitelists.AdmitAll, CancellationToken.None);

        Assert.Equal(1, result.ConvertedCount);

        Assert.NotNull(handler.ReconciledAudio);

        var audio = handler.ReconciledAudio;
        Assert.Equal(TimeSpan.FromSeconds(184), audio.Duration);
        Assert.Equal(Encoding.UTF8.GetBytes("converted"), audio.Content);
        Assert.Equal(".mp3", audio.Extension);
    }

    [Fact]
    public void ANullProfileSkipsTheTranscodeEntirely()
    {
        // A metadata-only item is a legitimate shape, not a failure.
        var handler = new RecordingHandler { Profile = null };

        var result = Pipeline(new ExplodingTranscoder()).Run(
            Archive("in.zip", Leaf("a.txt", "x")), handler, FieldWhitelists.AdmitAll, CancellationToken.None);

        Assert.Equal(1, result.ItemCount);
        Assert.Equal(0, result.ConvertedCount);
    }

    [Theory]
    [InlineData("ValidateContent")]
    [InlineData("Map")]
    [InlineData("Augment")]
    [InlineData("NameFor")]
    [InlineData("ProfileFor")]
    [InlineData("Reconcile")]
    public void AThrowFromAnyItemStageNamesTheItem(string stage)
    {
        // The item key is the whole diagnostic: a document of forty items whose ninth is malformed
        // is useless to an operator unless the message says which.
        var handler = new RecordingHandler { ThrowFrom = stage };

        var ex = Assert.Throws<NormalizationException>(
            () => Pipeline(new FakeTranscoder()).Run(
                Archive("in.zip", Leaf("ninth.wav", "x")), handler, FieldWhitelists.AdmitAll, CancellationToken.None));

        Assert.Contains("ninth.wav", ex.Message, StringComparison.Ordinal);
        Assert.Contains("refused it", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TheSecondItemIsNeverProcessedAfterTheFirstFails()
    {
        // NO PARTIAL OUTPUT, and no partial WORK either. Nine good items and one bad one is a failed
        // step; continuing past a failure would burn a transcode for a document already doomed.
        var handler = new RecordingHandler { ThrowFrom = "Map" };

        Assert.Throws<NormalizationException>(
            () => Pipeline(new FakeTranscoder()).Run(
                Archive("in.zip", Leaf("a.wav", "x"), Leaf("b.wav", "y")),
                handler,
                FieldWhitelists.AdmitAll,
                CancellationToken.None));

        Assert.Single(handler.Stages, s => s == nameof(handler.Map));
    }

    // ---- The artifact decision's three states, asserted directly. ----
    //
    // These three existed only transitively through chain tests before, and the INCOMPLETE arm not
    // at all: the whole suite stayed green with the pipeline's missing-required check deleted. That
    // arm is the mechanism this phase turns on, so it gets a test that fails when it goes.

    [Fact]
    public void AnUnsetMetadataProducesNoDocumentAndTheItemStillFlowsThrough()
    {
        // What keeps an identity handler possible: nothing populated means no artifact, and the
        // item is carried to stage 8 rather than being rejected.
        var handler = new RecordingHandler { Shape = MetadataShape.Unset };

        var result = Pipeline(new ExplodingTranscoder()).Run(
            Archive("in.zip", Leaf("a.wav", "x")), handler, FieldWhitelists.AdmitAll, CancellationToken.None);

        Assert.Equal(1, result.ItemCount);

        var item = Assert.Single(handler.LaidOut);
        Assert.Null(item.MetadataDocument);
        Assert.True(item.Metadata.IsUnset);
    }

    [Fact]
    public void AnIncompleteMetadataFailsAndNamesEveryMissingElementByItsXmlPath()
    {
        // A handler that populated SOME of the document and left a required element unset is a bug,
        // and §8 requires the failure to say WHICH elements -- by their XML path, because the
        // operator reading it is looking at an XML document, not at StandardMetadata.
        var handler = new RecordingHandler { Shape = MetadataShape.Incomplete };

        var ex = Assert.Throws<NormalizationException>(
            () => Pipeline(new ExplodingTranscoder()).Run(
                Archive("in.zip", Leaf("ninth.wav", "x")), handler, FieldWhitelists.AdmitAll, CancellationToken.None));

        Assert.Contains("source/originalName", ex.Message, StringComparison.Ordinal);
        Assert.Contains("audio/fileName", ex.Message, StringComparison.Ordinal);
        // The item key too: this is a per-item failure and goes through the same prepend.
        Assert.Contains("ninth.wav", ex.Message, StringComparison.Ordinal);

        // NO ARTIFACT AND NO STAGE 8. An incomplete document must be a failed step, never a quietly
        // different file.
        Assert.DoesNotContain(nameof(handler.LayoutFor), handler.Stages, StringComparer.Ordinal);
    }

    [Fact]
    public void ACompleteMetadataIsRenderedAndCarriedOnTheItem()
    {
        var handler = new RecordingHandler { Shape = MetadataShape.Complete };

        Pipeline(new ExplodingTranscoder()).Run(
            Archive("in.zip", Leaf("a.wav", "x")), handler, FieldWhitelists.AdmitAll, CancellationToken.None);

        var item = Assert.Single(handler.LaidOut);
        Assert.NotNull(item.MetadataDocument);

        // The rendered bytes, not a placeholder: the same thing the renderer produces for this
        // metadata, so a pipeline that handed stage 8 anything else fails here.
        Assert.Equal(
            new XmlMetadataRenderer().Render(item.Metadata),
            item.MetadataDocument);
    }

    [Fact]
    public void AThrowFromLocateIsReportedWithoutAnItemKey()
    {
        // Stage 1 has no item yet, so there is nothing to name. This is the "wrong handler for this
        // feed" failure, and its message must read as such rather than as a bare parse error.
        var handler = new RecordingHandler { ThrowFrom = "Locate" };

        var ex = Assert.Throws<NormalizationException>(
            () => Pipeline(new FakeTranscoder()).Run(
                Archive("in.zip", Leaf("a.wav", "x")), handler, FieldWhitelists.AdmitAll, CancellationToken.None));

        Assert.DoesNotContain("item '", ex.Message, StringComparison.Ordinal);
    }
}
