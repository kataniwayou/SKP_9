using System.Text;
using Processor.ArchiveCollapser;
using Processor.ArchiveCollapser.Writers;
using Processor.ArchiveExpander.Extractors;
using Xunit;

namespace BaseApi.Tests.ArchiveCollapser;

public sealed class ArchiveBuilderTests
{
    private static ArchiveBuilder Builder() => new([new ZipWriter(), new TarWriter()]);

    private static DateTime Stamp => new(2026, 6, 7, 8, 9, 10, DateTimeKind.Utc);

    private static FileNode Leaf(string name, string text)
        => new(
            new FileMetadata(name, Path.GetExtension(name), text.Length, null, Stamp, 0),
            new FileContent.Bytes(Encoding.UTF8.GetBytes(text)));

    private static FileNode Archive(string name, params FileNode[] entries)
        => new(
            new FileMetadata(name, Path.GetExtension(name), 999, null, Stamp, entries.Length),
            entries.Length == 0 ? null : new FileContent.Entries(entries));

    private static IReadOnlyList<ExtractedEntry> Unzip(byte[] archive)
    {
        using var stream = new MemoryStream(archive, writable: false);
        return new ZipExtractor().Extract(stream);
    }

    [Fact]
    public void APlainFileNodePassesItsBytesThroughUnchanged()
    {
        // Case 1, at the root: the document describes a plain file, so the collapser emits its
        // bytes. The inverse of ArchiveExpander leaving a CSV as a leaf.
        var built = Builder().Build(Leaf("orders.csv", "id,name"));

        Assert.Equal("id,name", Encoding.UTF8.GetString(built.Archive));
        Assert.Equal(0, built.DepthReached);
        Assert.Equal(0, built.EntryCount);
    }

    [Fact]
    public void AnArchiveNodePacksItsEntries()
    {
        var built = Builder().Build(Archive("orders.zip", Leaf("a.csv", "id"), Leaf("b.csv", "x")));

        Assert.Equal(["a.csv", "b.csv"], Unzip(built.Archive).Select(e => e.Name).ToArray());
        Assert.Equal(2, built.EntryCount);
        Assert.Equal(1, built.DepthReached);
    }

    [Fact]
    public void ANullContentProducesTheCanonicalEmptyArchive()
    {
        // Case 3. The expander turns an empty archive into null; null must turn back into the one
        // archive the expander's guard still calls healthy.
        var built = Builder().Build(Archive("empty.zip"));

        Assert.Equal(22, built.Archive.Length);
        Assert.Equal(0, built.EntryCount);
    }

    [Fact]
    public void ANestedArchiveIsPackedRecursively()
    {
        // Depth 2 -- root -> inner archive -> leaves. This is the case the identity test runs at,
        // and the reason the recursion is not decorative.
        var built = Builder().Build(
            Archive("outer.zip", Archive("inner.zip", Leaf("a.csv", "id")), Leaf("b.csv", "x")));

        Assert.Equal(2, built.DepthReached);

        var outer = Unzip(built.Archive);
        Assert.Equal(["inner.zip", "b.csv"], outer.Select(e => e.Name).ToArray());
        Assert.Equal("a.csv", Assert.Single(Unzip(outer[0].Content)).Name);
    }

    [Fact]
    public void AMixedFormatTreePacksATarInsideAZip()
    {
        // The extension decides PER NODE, not once for the document.
        var built = Builder().Build(
            Archive("outer.zip", Archive("inner.tar", Leaf("a.csv", "id"))));

        var inner = Assert.Single(Unzip(built.Archive));
        Assert.Equal("inner.tar", inner.Name);
        Assert.True(new TarExtractor().CanHandle(inner.Content));
    }

    [Fact]
    public void ANodeWithEntriesWhoseExtensionNamesNoWriterFails()
    {
        var ex = Assert.Throws<ArchiveWritingException>(
            () => Builder().Build(Archive("orders.csv", Leaf("a.csv", "id"))));

        Assert.Contains("orders.csv", ex.Message, StringComparison.Ordinal);
        Assert.Contains(".csv", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ARarNodeWithEntriesFailsWithItsOwnMessage()
    {
        // Its own message because "RAR cannot be written" is a permanent property of the format,
        // not a typo in the document -- an operator must not spend an afternoon fixing a name.
        var ex = Assert.Throws<ArchiveWritingException>(
            () => Builder().Build(Archive("orders.rar", Leaf("a.csv", "id"))));

        Assert.Contains("RAR cannot be written", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ANodeNamedAsAnArchiveButCarryingBytesIsAPlainEntry()
    {
        // Case 2's counterpart: a node carrying its own bytes is a file, whatever it is named. An
        // already-built archive is carried along rather than re-opened and re-packed.
        var alreadyBuilt = new ZipWriter().Write([new ArchiveEntry("x.csv", "id"u8.ToArray(), Stamp)]);

        var built = Builder().Build(
            Archive("outer.zip",
                new FileNode(
                    new FileMetadata("carried.zip", ".zip", alreadyBuilt.Length, null, Stamp, 0),
                    new FileContent.Bytes(alreadyBuilt))));

        Assert.Equal(alreadyBuilt, Assert.Single(Unzip(built.Archive)).Content);
    }

    [Theory]
    [InlineData("a/b.csv")]
    [InlineData("a\\b.csv")]
    public void ANodeNameCarryingAPathSeparatorFails(string name)
    {
        // The expander strips directories on read, so writing real structure would be flattened
        // straight back and would break the fixed point. Rejected rather than silently stripped,
        // which would hide a malformed document.
        var ex = Assert.Throws<ArchiveWritingException>(
            () => Builder().Build(Archive("outer.zip", Leaf(name, "id"))));

        Assert.Contains("path separator", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void DuplicateSiblingNamesAreAllowed()
    {
        // Zip permits them and the expander reads both back, so the round trip survives.
        var built = Builder().Build(Archive("outer.zip", Leaf("a.csv", "one"), Leaf("a.csv", "two")));

        Assert.Equal(2, Unzip(built.Archive).Count);
    }

    [Fact]
    public void ADocumentDeeperThanMaxSupportedDepthFails()
    {
        var node = Leaf("leaf.csv", "id");

        for (var i = 0; i <= ArchiveBuilder.MaxSupportedDepth; i++)
        {
            node = Archive("a.zip", node);
        }

        var ex = Assert.Throws<ArchiveWritingException>(() => Builder().Build(node));

        Assert.Contains("nests deeper", ex.Message, StringComparison.Ordinal);
    }
}
