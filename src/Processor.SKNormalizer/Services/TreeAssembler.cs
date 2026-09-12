namespace Processor.SKNormalizer;

/// <summary>
/// The ONLY code in this processor that sets a node name or sets an extension on an entries-bearing
/// node. Every rule ArchiveCollapser enforces is enforced here first, where the message can name the
/// offending node.
/// <para>
/// <b>It COMPUTES a leaf's SizeBytes and every node's EntryCount, and CARRIES everything else.</b>
/// A leaf's size is its content length and an entry count is the number of children — both are facts
/// this code holds. A container's size is not: nothing is packed here, so the only number available
/// is the one upstream wrote, and inventing a different one would break the byte identity that is
/// this processor's acceptance test. Timestamps are carried for the same reason.
/// </para>
/// </summary>
internal sealed class TreeAssembler : ITreeAssembler
{
    /// <summary>Mirrors <c>ArchiveBuilder.MaxSupportedDepth</c>, which fails one hop later.</summary>
    public const int MaxSupportedDepth = 4;

    /// <summary>
    /// What ArchiveCollapser can WRITE. Rar is absent and will stay absent: RarLab's unrar licence
    /// permits decompression only and forbids building a compressor from that source, so no open
    /// library writes rar. <c>TreeAssemblerTests.TheWritableExtensionListMatchesTheCollapsersWriters</c>
    /// is what keeps this in step with the collapser's registrations.
    /// </summary>
    public static readonly IReadOnlyList<string> WritableExtensions = [".tar", ".zip"];

    /// <summary>Where a container whose format cannot be written is retargeted.</summary>
    public const string DefaultArchiveExtension = ".zip";

    public FileNode Assemble(OutputLayout layout)
    {
        ArgumentNullException.ThrowIfNull(layout);

        var extension = Writable(layout.RootExtension);
        var rootName = Check(layout.RootName);
        var children = layout.Children is null
            ? null
            : layout.Children.Select(c => Build(c, depth: 1)).ToList();

        return new FileNode(
            new FileMetadata(
                Retarget(rootName, layout.RootExtension, extension),
                extension,
                layout.SizeBytes,
                layout.CreatedUtc,
                layout.ModifiedUtc,
                children?.Count ?? 0),
            children is null ? null : new FileContent.Entries(children));
    }

    private FileNode Build(OutputNode node, int depth)
    {
        if (depth > MaxSupportedDepth)
        {
            throw new NormalizationException(
                $"the layout nests deeper than {MaxSupportedDepth} levels, at '{Name(node)}'");
        }

        return node switch
        {
            OutputNode.File file => Leaf(file),
            OutputNode.Folder folder => Folder(folder, depth),
            _ => throw new NormalizationException($"unknown output node '{Name(node)}'"),
        };
    }

    private static FileNode Leaf(OutputNode.File file)
    {
        var name = Check(file.Name);

        // A LEAF KEEPS ITS EXTENSION, whatever it is. A leaf named .rar is an already-built archive
        // being carried along, which is exactly how ArchiveBuilder reads it. Only entries-bearing
        // nodes are retargeted.
        return new FileNode(
            new FileMetadata(
                name,
                Path.GetExtension(name),
                // COMPUTED: a leaf's size is its content, and a wrong value upstream must not
                // propagate as if it were a fact.
                file.Content.LongLength,
                file.CreatedUtc,
                file.ModifiedUtc,
                0),
            new FileContent.Bytes(file.Content));
    }

    private FileNode Folder(OutputNode.Folder folder, int depth)
    {
        var extension = Writable(folder.ArchiveExtension);
        var name = Retarget(Check(folder.Name), folder.ArchiveExtension, extension);
        var children = folder.Children.Select(c => Build(c, depth + 1)).ToList();

        return new FileNode(
            new FileMetadata(
                name, extension, folder.SizeBytes, folder.CreatedUtc, folder.ModifiedUtc, children.Count),
            new FileContent.Entries(children));
    }

    private static string Check(string name)
    {
        // Rejected rather than stripped, matching ArchiveBuilder.Pack: the expander strips
        // directories on read, so writing real structure here would be flattened straight back —
        // and stripping would hide a malformed document rather than report it.
        if (name.Contains('/') || name.Contains('\\'))
        {
            throw new NormalizationException(
                $"the node name '{name}' carries a path separator; a node name is a name, never a path");
        }

        if (name.Length == 0)
        {
            throw new NormalizationException("a node name is empty");
        }

        return name;
    }

    private static string Writable(string extension)
        => WritableExtensions.Any(e => e.Equals(extension, StringComparison.OrdinalIgnoreCase))
            ? extension
            : DefaultArchiveExtension;

    private static string Retarget(string name, string from, string to)
        => from.Equals(to, StringComparison.OrdinalIgnoreCase)
            ? name
            : Path.ChangeExtension(name, to);

    private static string Name(OutputNode node) => node switch
    {
        OutputNode.File f => f.Name,
        OutputNode.Folder d => d.Name,
        _ => "<unknown>",
    };
}
