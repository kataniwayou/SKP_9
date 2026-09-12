using System.Text;
using Processor.SKNormalizer;
using Xunit;

namespace BaseApi.Tests.SKNormalizer;

/// <summary>
/// The mirror, tested DIRECTLY. It was the only component on this branch with no test of its own,
/// and that is exactly how three defects reached the whole-branch review: every existing test reached
/// it through the pipeline, where the assembler's output is the only thing visible and a layout that
/// says the wrong thing can still serialize into something plausible.
/// </summary>
public sealed class ProviderHandlerBaseTests
{
    private static DateTime Stamp => new(2026, 6, 7, 8, 9, 10, DateTimeKind.Utc);

    private static DateTime Born => new(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);

    /// <summary>Nothing but the base defaults; Locate is the one member the base cannot supply.</summary>
    private sealed class Bare : ProviderHandlerBase
    {
        public override string Name => "Bare";

        public override IReadOnlyList<SourceItem> Locate(FileNode root) => [];
    }

    private static FileNode Leaf(string name, string text)
        => new(
            new FileMetadata(name, Path.GetExtension(name), text.Length, Born, Stamp, 0),
            new FileContent.Bytes(Encoding.UTF8.GetBytes(text)));

    private static FileNode Archive(string name, long sizeBytes, params FileNode[] entries)
        => new(
            new FileMetadata(name, Path.GetExtension(name), sizeBytes, Born, Stamp, entries.Length),
            entries.Length == 0 ? null : new FileContent.Entries(entries));

    private static OutputLayout Layout(FileNode root) => new Bare().LayoutFor(root, []);

    [Fact]
    public void TheMirrorPreservesEveryFieldOfATwoLevelDocument()
    {
        // TOPOLOGY IS NOT JUST SHAPE. Nesting, entry counts, names, extensions, sizes and BOTH
        // timestamps are asserted at all three levels, because a mirror that keeps the shape and
        // drops modifiedUtc has still lost the document.
        var root = Archive(
            "bundle.tar", 40219,
            Archive("inner.zip", 512, Leaf("a.csv", "id"), Leaf("b.csv", "id,name")),
            Leaf("notes.txt", "hello"));

        var layout = Layout(root);

        var folder = Assert.IsType<OutputNode.Folder>(layout.Root);
        Assert.Equal("bundle.tar", folder.Name);
        Assert.Equal(".tar", folder.ArchiveExtension);
        Assert.Equal(40219, folder.SizeBytes);
        Assert.Equal(Born, folder.CreatedUtc);
        Assert.Equal(Stamp, folder.ModifiedUtc);
        Assert.Equal(2, folder.Children!.Count);

        var inner = Assert.IsType<OutputNode.Folder>(folder.Children[0]);
        Assert.Equal("inner.zip", inner.Name);
        Assert.Equal(".zip", inner.ArchiveExtension);
        Assert.Equal(512, inner.SizeBytes);
        Assert.Equal(Born, inner.CreatedUtc);
        Assert.Equal(Stamp, inner.ModifiedUtc);
        Assert.Equal(2, inner.Children!.Count);

        var first = Assert.IsType<OutputNode.File>(inner.Children[0]);
        Assert.Equal("a.csv", first.Name);
        Assert.Equal(Encoding.UTF8.GetBytes("id"), first.Content);
        Assert.Equal(Born, first.CreatedUtc);
        Assert.Equal(Stamp, first.ModifiedUtc);

        Assert.Equal("b.csv", Assert.IsType<OutputNode.File>(inner.Children[1]).Name);

        var sibling = Assert.IsType<OutputNode.File>(folder.Children[1]);
        Assert.Equal("notes.txt", sibling.Name);
        Assert.Equal(Encoding.UTF8.GetBytes("hello"), sibling.Content);
    }

    [Fact]
    public void ALeafRootMirrorsToALeafRootAndKeepsItsBytes()
    {
        // The expander emits a bytes root for every fetched file it does not recognise as an archive.
        // Mirrored as a childless container, that document left this processor as an empty zip.
        var layout = Layout(Leaf("report.csv", "id,name"));

        var file = Assert.IsType<OutputNode.File>(layout.Root);
        Assert.Equal("report.csv", file.Name);
        Assert.Equal(Encoding.UTF8.GetBytes("id,name"), file.Content);
        Assert.Equal(Born, file.CreatedUtc);
        Assert.Equal(Stamp, file.ModifiedUtc);
    }

    [Fact]
    public void AnEmptyArchiveMirrorsToNullChildrenRatherThanAnEmptyList()
    {
        // "Expanded to nothing" is null in the input and must stay null in the output, at the root
        // and at depth alike -- see TreeAssemblerTests for what the assembler then emits.
        var root = Archive("bundle.zip", 22, Archive("inner.zip", 22));

        var folder = Assert.IsType<OutputNode.Folder>(Layout(root).Root);
        var inner = Assert.IsType<OutputNode.Folder>(folder.Children!.Single());

        Assert.Null(inner.Children);
    }

    [Fact]
    public void TheMirrorSubstitutesNothingEvenWhenItemsCarryArtifacts()
    {
        // THE BASE MIRROR IS A PURE PASS-THROUGH, and this pins it. It once threaded a `replacements`
        // dictionary through the recursion and never read it, so a handler that requested a
        // conversion was logged as converted and emitted the original bytes. Substitution belongs to
        // a handler's own LayoutFor, which is why the artifacts below are ignored here.
        var leaf = Leaf("a.wav", "original");
        var root = Archive("bundle.zip", 100, leaf);

        var metadata = new StandardMetadata();
        metadata.Title = "a.wav";

        var item = new NormalizedItem(
            new SourceItem("a.wav", [leaf]),
            metadata,
            new ItemNames("a.xml", "a.mp3"),
            new NormalizedAudio(Encoding.UTF8.GetBytes("converted"), ".mp3", 9, null, null, "mp3"),
            Encoding.UTF8.GetBytes("<metadata/>"));

        var folder = Assert.IsType<OutputNode.Folder>(new Bare().LayoutFor(root, [item]).Root);
        var only = Assert.IsType<OutputNode.File>(folder.Children!.Single());

        Assert.Equal("a.wav", only.Name);
        Assert.Equal(Encoding.UTF8.GetBytes("original"), only.Content);
    }
}
