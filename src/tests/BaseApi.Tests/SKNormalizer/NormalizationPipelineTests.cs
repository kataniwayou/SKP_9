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

            var metadata = new StandardMetadata();
            metadata.Set("key", item.Key);
            return metadata;
        }

        public override void Augment(StandardMetadata metadata, SourceItem item)
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

            if (audio?.Duration is { } duration)
            {
                metadata.Set("duration", duration.TotalSeconds.ToString("F0"));
            }
        }

        public override OutputLayout LayoutFor(FileNode root, IReadOnlyList<NormalizedItem> items)
        {
            Enter(nameof(LayoutFor));
            return base.LayoutFor(root, items);
        }
    }

    private static NormalizationPipeline Pipeline(IAudioTranscoder transcoder)
        => new(new TreeAssembler(), new XmlMetadataRenderer(), transcoder);

    [Fact]
    public void TheStagesRunInTheDocumentedOrder()
    {
        var handler = new RecordingHandler { Profile = new AudioProfile(".mp3", ["-b:a", "192k"]) };

        Pipeline(new FakeTranscoder()).Run(
            Archive("in.zip", Leaf("a.wav", "x")), handler, CancellationToken.None);

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
    public void ReconcileSeesWhatTheTranscoderProduced()
    {
        // The whole reason stage 7 exists: duration is knowable nowhere before conversion.
        var handler = new RecordingHandler { Profile = new AudioProfile(".mp3", []) };

        var result = Pipeline(new FakeTranscoder()).Run(
            Archive("in.zip", Leaf("a.wav", "x")), handler, CancellationToken.None);

        Assert.Equal(1, result.ConvertedCount);
    }

    [Fact]
    public void ANullProfileSkipsTheTranscodeEntirely()
    {
        // A metadata-only item is a legitimate shape, not a failure.
        var handler = new RecordingHandler { Profile = null };

        var result = Pipeline(new ExplodingTranscoder()).Run(
            Archive("in.zip", Leaf("a.txt", "x")), handler, CancellationToken.None);

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
                Archive("in.zip", Leaf("ninth.wav", "x")), handler, CancellationToken.None));

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
                CancellationToken.None));

        Assert.Single(handler.Stages, s => s == nameof(handler.Map));
    }

    [Fact]
    public void AThrowFromLocateIsReportedWithoutAnItemKey()
    {
        // Stage 1 has no item yet, so there is nothing to name. This is the "wrong handler for this
        // feed" failure, and its message must read as such rather than as a bare parse error.
        var handler = new RecordingHandler { ThrowFrom = "Locate" };

        var ex = Assert.Throws<NormalizationException>(
            () => Pipeline(new FakeTranscoder()).Run(
                Archive("in.zip", Leaf("a.wav", "x")), handler, CancellationToken.None));

        Assert.DoesNotContain("item '", ex.Message, StringComparison.Ordinal);
    }
}
