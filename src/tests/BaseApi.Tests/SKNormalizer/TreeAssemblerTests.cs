using System.Text;
using Processor.ArchiveCollapser.Writers;
using Processor.SKNormalizer;
using Xunit;

namespace BaseApi.Tests.SKNormalizer;

public sealed class TreeAssemblerTests
{
    private static DateTime Stamp => new(2026, 6, 7, 8, 9, 10, DateTimeKind.Utc);

    private static DateTime Born => new(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);

    private static OutputNode.File File(string name, string text)
        => new(name, Encoding.UTF8.GetBytes(text), Born, Stamp);

    private static OutputLayout Root(string name, string extension, params OutputNode[] children)
        => new(name, extension, SizeBytes: 40219, Born, Stamp, children);

    private static FileNode Assemble(OutputLayout layout) => new TreeAssembler().Assemble(layout);

    [Fact]
    public void ANameCarryingAPathSeparatorIsRejected()
    {
        // ArchiveBuilder.Pack rejects rather than strips, because stripping hides a malformed
        // document. This refuses it one hop earlier, where the message can name the offender.
        var layout = Root("out.zip", ".zip", File("audio/track01.wav", "x"));

        var ex = Assert.Throws<NormalizationException>(() => Assemble(layout));
        Assert.Contains("audio/track01.wav", ex.Message);
    }

    [Theory]
    [InlineData("\\")]
    [InlineData("/")]
    public void BothSeparatorsAreRejected(string separator)
    {
        var layout = Root("out.zip", ".zip", File($"a{separator}b.xml", "x"));

        Assert.Throws<NormalizationException>(() => Assemble(layout));
    }

    [Fact]
    public void AFolderNamedWithANonWritableExtensionIsRetargetedToZip()
    {
        // The rar rule. ArchiveExpander READS rar; ArchiveCollapser cannot WRITE it, so a faithful
        // topology mirror of a rar-sourced document would walk straight into a collapser refusal.
        var layout = Root(
            "bundle.rar", ".rar",
            new OutputNode.Folder("item01.rar", ".rar", 512, Born, Stamp, [File("meta.xml", "<m/>")]));

        var root = Assemble(layout);

        Assert.Equal(".zip", root.Metadata.Extension);
        Assert.Equal("bundle.zip", root.Metadata.Name);

        var child = Assert.IsType<FileContent.Entries>(root.Content).Value.Single();
        Assert.Equal(".zip", child.Metadata.Extension);
        Assert.Equal("item01.zip", child.Metadata.Name);
    }

    [Fact]
    public void AWritableFolderExtensionIsLeftAlone()
    {
        var layout = Root(
            "bundle.tar", ".tar",
            new OutputNode.Folder("item01.zip", ".zip", 512, Born, Stamp, [File("meta.xml", "<m/>")]));

        var root = Assemble(layout);

        Assert.Equal(".tar", root.Metadata.Extension);
        Assert.Equal("bundle.tar", root.Metadata.Name);
        Assert.Equal(".zip",
            Assert.IsType<FileContent.Entries>(root.Content).Value.Single().Metadata.Extension);
    }

    [Fact]
    public void ALeafKeepsWhateverExtensionItsHandlerGaveIt()
    {
        // Only entries-bearing nodes are retargeted. A leaf named .rar is an already-built archive
        // being carried along, exactly as ArchiveBuilder treats it.
        var root = Assemble(Root("out.zip", ".zip", File("inner.rar", "x")));

        var leaf = Assert.IsType<FileContent.Entries>(root.Content).Value.Single();
        Assert.Equal(".rar", leaf.Metadata.Extension);
        Assert.Equal("inner.rar", leaf.Metadata.Name);
    }

    [Fact]
    public void ALeafsSizeIsItsContentAndEveryEntryCountIsCounted()
    {
        var root = Assemble(Root("out.zip", ".zip", File("a.xml", "<a/>"), File("b.xml", "<bb/>")));

        Assert.Equal(2, root.Metadata.EntryCount);

        var entries = Assert.IsType<FileContent.Entries>(root.Content).Value;
        Assert.Equal(4, entries[0].Metadata.SizeBytes);
        Assert.Equal(5, entries[1].Metadata.SizeBytes);
        Assert.Equal(0, entries[0].Metadata.EntryCount);
    }

    [Fact]
    public void AContainerKeepsTheSizeItWasGivenRatherThanTheSumOfItsChildren()
    {
        // THIS PROCESSOR PACKS NO ARCHIVE, so a container has no "built" size to be honest about.
        // ArchiveExpander writes the SOURCE ARCHIVE's byte length there (FileContentBuilder.cs:131),
        // and summing children instead would make byte identity impossible -- which is this phase's
        // acceptance test. ArchiveCollapser recomputes the number from what it actually packs, so
        // carrying the upstream value forward misleads nobody.
        var root = Assemble(Root("out.zip", ".zip", File("a.xml", "<a/>")));

        Assert.Equal(40219, root.Metadata.SizeBytes);
        Assert.NotEqual(4, root.Metadata.SizeBytes);
    }

    [Fact]
    public void TimestampsSurviveOnEveryNode()
    {
        // DISTINCT values, deliberately: two NotNull checks would pass just as happily if the
        // assembler TRANSPOSED CreatedUtc and ModifiedUtc. ArchiveExpander writes both on every node,
        // so dropping either makes the identity chain of Task 9 unpassable.
        var root = Assemble(Root(
            "out.zip", ".zip",
            new OutputNode.Folder("inner.zip", ".zip", 99, Born, Stamp, [File("a.xml", "<a/>")])));

        Assert.Equal(Born, root.Metadata.CreatedUtc);
        Assert.Equal(Stamp, root.Metadata.ModifiedUtc);

        var inner = Assert.IsType<FileContent.Entries>(root.Content).Value.Single();
        Assert.Equal(Born, inner.Metadata.CreatedUtc);
        Assert.Equal(Stamp, inner.Metadata.ModifiedUtc);

        var leaf = Assert.IsType<FileContent.Entries>(inner.Content).Value.Single();
        Assert.Equal(Born, leaf.Metadata.CreatedUtc);
        Assert.Equal(Stamp, leaf.Metadata.ModifiedUtc);
    }

    [Fact]
    public void ALayoutDeeperThanTheCapIsRejected()
    {
        OutputNode node = File("leaf.xml", "x");
        for (var i = 0; i < TreeAssembler.MaxSupportedDepth + 1; i++)
        {
            node = new OutputNode.Folder($"level{i}.zip", ".zip", 0, Born, Stamp, [node]);
        }

        var ex = Assert.Throws<NormalizationException>(
            () => Assemble(Root("out.zip", ".zip", node)));
        Assert.Contains("nests deeper", ex.Message);
    }

    [Fact]
    public void ARootWithNoChildrenBecomesNullContentNotAnEmptyArray()
    {
        // ArchiveBuilder treats null as "pack the format's canonical empty archive" and an empty
        // Entries list identically — but the tree schema and the expander both express "expanded to
        // nothing" as null, so this must match.
        var root = Assemble(new OutputLayout("empty.zip", ".zip", 22, Born, Stamp, null));

        Assert.Null(root.Content);
        Assert.Equal(0, root.Metadata.EntryCount);
    }

    [Fact]
    public void TheWritableExtensionListMatchesTheCollapsersWriters()
    {
        // A KNOWING DUPLICATION ACROSS PROCESS BOUNDARIES, pinned here. The assembler cannot ask the
        // collapser what it can write, so this test is the only thing keeping the two in step. If
        // the collapser ever gains a writer, this fails and the assembler is updated.
        IArchiveWriter[] writers = [new ZipWriter(), new TarWriter()];

        Assert.Equal(
            writers.Select(w => w.Extension).Order().ToArray(),
            TreeAssembler.WritableExtensions.Order().ToArray());
    }
}
