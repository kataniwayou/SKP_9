namespace Processor.SKNormalizer;

/// <summary>
/// Defaults for the stages most providers will not vary. A convenience only: the INTERFACE is the
/// contract, and nothing may bind to this type.
/// </summary>
public abstract class ProviderHandlerBase : IProviderHandler
{
    public abstract string Name { get; }

    public abstract IReadOnlyList<SourceItem> Locate(FileNode root);

    public virtual void ValidateContent(SourceItem item)
    {
    }

    public virtual StandardMetadata Map(SourceItem item) => new();

    public virtual void Augment(StandardMetadata metadata, SourceItem item)
    {
    }

    public virtual ItemNames NameFor(StandardMetadata metadata, SourceItem item)
        => new($"{item.Key}.xml", $"{item.Key}");

    public virtual AudioProfile? ProfileFor(SourceItem item) => null;

    public virtual void Reconcile(StandardMetadata metadata, NormalizedAudio? audio, ItemNames names)
    {
    }

    /// <summary>
    /// Stage 8, default: <b>preserve the input topology</b>. Same nesting, same entry count; only
    /// contents, names and extensions change. Most handlers never override this.
    /// <para>
    /// <b>It satisfies the output schema by construction.</b> Output depth equals input depth, and
    /// the input arrived through the same registered row — so no handler has to think about the
    /// row's depth.
    /// </para>
    /// <para>
    /// <b>A leaf with no artifact passes through unchanged.</b> That is what makes an identity
    /// handler expressible, and it is also how a metadata-only item and a deliberate pass-through
    /// are expressed.
    /// </para>
    /// </summary>
    public virtual OutputLayout LayoutFor(FileNode root, IReadOnlyList<NormalizedItem> items)
    {
        ArgumentNullException.ThrowIfNull(root);
        ArgumentNullException.ThrowIfNull(items);

        // Keyed on the node the item was located from, so a substitution lands in the position the
        // source occupied rather than being appended somewhere.
        var replacements = new Dictionary<FileNode, NormalizedItem>();

        foreach (var item in items)
        {
            foreach (var node in item.Source.Nodes)
            {
                replacements[node] = item;
            }
        }

        // EVERY FIELD CARRIED, not just the name. Size and both timestamps travel with each node,
        // because preserving topology that loses metadata is not preserving the document.
        return new OutputLayout(
            root.Metadata.Name,
            root.Metadata.Extension,
            root.Metadata.SizeBytes,
            root.Metadata.CreatedUtc,
            root.Metadata.ModifiedUtc,
            root.Content is FileContent.Entries entries
                ? entries.Value.Select(e => Mirror(e, replacements)).ToList()
                : null);
    }

    private static OutputNode Mirror(
        FileNode node, IReadOnlyDictionary<FileNode, NormalizedItem> replacements)
        => node.Content switch
        {
            FileContent.Entries entries => new OutputNode.Folder(
                node.Metadata.Name,
                node.Metadata.Extension,
                node.Metadata.SizeBytes,
                node.Metadata.CreatedUtc,
                node.Metadata.ModifiedUtc,
                entries.Value.Select(e => Mirror(e, replacements)).ToList()),

            FileContent.Bytes bytes => new OutputNode.File(
                node.Metadata.Name, bytes.Value, node.Metadata.CreatedUtc, node.Metadata.ModifiedUtc),

            // An archive that expanded to nothing. Mirrored as an empty container, which the
            // assembler turns back into the format's canonical empty archive.
            _ => new OutputNode.Folder(
                node.Metadata.Name,
                node.Metadata.Extension,
                node.Metadata.SizeBytes,
                node.Metadata.CreatedUtc,
                node.Metadata.ModifiedUtc,
                []),
        };
}
