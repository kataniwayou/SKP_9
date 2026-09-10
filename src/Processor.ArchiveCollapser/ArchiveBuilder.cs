using Processor.ArchiveCollapser.Writers;

namespace Processor.ArchiveCollapser;

/// <summary>
/// The archive, how deep the document went, and how many entries its root held.
/// <para>
/// <b><c>EntryCount</c> is counted from the CONTENT, never read from <c>metadata.entryCount</c>.</b>
/// The array is the fact and the count is derived -- the same rule ArchiveExpander's schema README
/// states from the other side -- so a wrong count in the input document cannot propagate into the
/// log line as if it were true.
/// </para>
/// <para>
/// <b><c>DepthReached</c> is returned rather than logged here because this is the only place it
/// survives.</b> The outbound envelope schema says nothing about depth, so if the input schema row
/// is not registered nothing downstream records how deep the document actually was.
/// </para>
/// </summary>
internal sealed record CollapseResult(byte[] Archive, int DepthReached, int EntryCount);

/// <summary>
/// Stage two: everything that involves looking inside the document. Stage one -- the processor -- is
/// dry and hands this class a tree it has already read.
/// <para>
/// <b>The writer is selected by the node's DECLARED EXTENSION, at every level.</b> There is no
/// signature dispatch and no <c>CanHandle</c>: on the way out there are no bytes yet, so the only
/// thing a node carries about what it should become is its name. See <see cref="IArchiveWriter"/>.
/// </para>
/// </summary>
internal sealed class ArchiveBuilder(IEnumerable<IArchiveWriter> writers)
{
    /// <summary>
    /// The deepest document this will pack.
    /// <para>
    /// <b>This is the SECOND guard, not the first.</b> <c>FileNodeConverter.Read</c> recurses while
    /// deserializing, so a pathologically deep document is refused by
    /// <c>JsonSerializerOptions.MaxDepth</c> before a tree ever reaches this class -- pinned by
    /// <c>FileNodeReadTests.ADeeplyNestedDocumentIsRefusedByTheDeserializer</c>. This bound exists
    /// so that the recursion below is safe to read and safe to run regardless, and it matches
    /// <c>ArchiveExpanderConfig.MaxSupportedDepth</c> so the two halves of the loop agree.
    /// </para>
    /// <para>
    /// <b>It is checked DURING the walk, unlike the expander's.</b> There, <c>MaxDepth</c> is
    /// validated before a single file is opened, so the stack bound is fixed up front. Here the
    /// depth arrives with the document and can only be discovered.
    /// </para>
    /// </summary>
    public const int MaxSupportedDepth = 64;

    private readonly IReadOnlyList<IArchiveWriter> _writers = writers.ToList();

    /// <summary>The archive this document describes.</summary>
    public CollapseResult Build(FileNode root)
    {
        var depthReached = 0;
        var bytes = BuildNode(root, depth: 0, ref depthReached);

        return new CollapseResult(
            bytes,
            depthReached,
            root.Content is FileContent.Entries entries ? entries.Value.Count : 0);
    }

    /// <summary>One node's bytes, and its subtree's.</summary>
    private byte[] BuildNode(FileNode node, int depth, ref int depthReached)
    {
        if (depth > depthReached)
        {
            depthReached = depth;
        }

        if (depth > MaxSupportedDepth)
        {
            throw new ArchiveWritingException(
                $"the document nests deeper than {MaxSupportedDepth} levels, at '{node.Metadata.Name}'");
        }

        return node.Content switch
        {
            // Case 1: a leaf. Its bytes are its content, whatever the extension claims -- the mirror
            // of "an unexpanded archive is a file". A node named .zip holding base64 is an
            // already-built archive being carried along, and re-opening it to re-pack it would be
            // work the document did not ask for.
            FileContent.Bytes bytes => bytes.Value,

            // Case 2: an archive.
            FileContent.Entries entries => Pack(node, entries.Value, depth, ref depthReached),

            // Case 3: null -- an archive that expanded to nothing. Packing an empty list produces
            // the format's canonical empty archive, which is exactly what the expander's
            // false-HEALTHY guards still admit. That is the loop closing.
            _ => Pack(node, [], depth, ref depthReached),
        };
    }

    private byte[] Pack(FileNode node, IReadOnlyList<FileNode> children, int depth, ref int depthReached)
    {
        // Case 4 lives here: content says "these are my entries" and the name says nothing can pack
        // them. Resolved BEFORE any child is built, so a document that cannot possibly succeed fails
        // without first materialising a subtree.
        var writer = Match(node.Metadata.Extension) ?? throw NoWriter(node);

        var entries = new List<ArchiveEntry>(children.Count);

        foreach (var child in children)
        {
            var name = child.Metadata.Name;

            // A name is a name, never a path. The expander strips directories on read -- entry.Name
            // in zip, Path.GetFileName in tar -- so writing real structure here would be flattened
            // straight back, quietly breaking the fixed point. Rejected rather than stripped:
            // stripping would hide a malformed document.
            if (name.Contains('/') || name.Contains('\\'))
            {
                throw new ArchiveWritingException(
                    $"the node name '{name}' carries a path separator; a node name is a name, never a path");
            }

            entries.Add(new ArchiveEntry(
                name,
                BuildNode(child, depth + 1, ref depthReached),
                child.Metadata.ModifiedUtc));
        }

        return writer.Write(entries);
    }

    /// <summary>The writer claiming this extension, or null when none does.</summary>
    private IArchiveWriter? Match(string extension)
        => _writers.FirstOrDefault(
            w => w.Extension.Equals(extension, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// The failure for a node that must be an archive and names no writer. RAR gets its own message
    /// because it is a permanent property of the format rather than a typo, and an operator who
    /// hits it must not spend an afternoon correcting a name that was never the problem.
    /// </summary>
    private static ArchiveWritingException NoWriter(FileNode node)
        => node.Metadata.Extension.Equals(".rar", StringComparison.OrdinalIgnoreCase)
            ? new ArchiveWritingException(
                $"'{node.Metadata.Name}' holds entries and is named .rar, and RAR cannot be written "
                + "— the format is proprietary and is readable but not writable here. Re-target the "
                + "node to .zip or .tar.")
            : new ArchiveWritingException(
                $"'{node.Metadata.Name}' is an archive -- it carries entries, or null meaning "
                + "entries that expanded to nothing -- but its extension "
                + $"'{node.Metadata.Extension}' names no archive writer");
}
