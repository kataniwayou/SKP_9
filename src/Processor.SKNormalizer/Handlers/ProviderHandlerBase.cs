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

    /// <summary>
    /// Stage 7, default: <b>a no-op, and it must stay one.</b> An obvious "improvement" is to fold
    /// <c>names.AudioFileName</c> in here, the way <c>AcmeHandler.Reconcile</c> does — but that would
    /// leave every handler that does not override this with a metadata object that is no longer
    /// <c>IsUnset</c> and is missing every other required element. <c>SampleHandler</c>'s identity
    /// pass-through depends on <c>IsUnset</c> staying true, so such a base would silently turn every
    /// identity dispatch into an incomplete-metadata failed step.
    /// </summary>
    public virtual void Reconcile(StandardMetadata metadata, NormalizedAudio? audio, ItemNames names)
    {
    }

    /// <summary>
    /// Stage 8, default: <b>reproduce the input document exactly</b>. Same nesting, same entry
    /// count, same names, extensions, sizes and both timestamps. Nothing is substituted. Most
    /// handlers never override this.
    /// <para>
    /// <b>That is precisely what an identity handler needs</b>, and it is what makes §6.1's "output
    /// depth equals input depth" true by construction: the input arrived through the same registered
    /// row, so the row admits the output without any handler having to think about depth.
    /// </para>
    /// <para>
    /// <b>This default emits no artifacts, deliberately.</b> A handler that produces metadata or
    /// converted audio overrides <c>LayoutFor</c> and builds its own layout from the
    /// <see cref="NormalizedItem"/> list it is handed — each item carries its rendered
    /// <c>MetadataDocument</c>, its <c>Audio</c> and the <c>Names</c> chosen at stage 5. Substituting
    /// here instead would require this base class to decide which source node corresponds to which
    /// artifact, and that correspondence is an open question (the design's §14) that the first real
    /// provider handler should settle rather than inherit.
    /// </para>
    /// </summary>
    public virtual OutputLayout LayoutFor(FileNode root, IReadOnlyList<NormalizedItem> items)
    {
        ArgumentNullException.ThrowIfNull(root);
        ArgumentNullException.ThrowIfNull(items);

        return new OutputLayout(Mirror(root));
    }

    /// <summary>
    /// EVERY FIELD CARRIED, not just the name. Size and both timestamps travel with each node,
    /// because preserving topology that loses metadata is not preserving the document.
    /// </summary>
    private static OutputNode Mirror(FileNode node)
        => node.Content switch
        {
            FileContent.Entries entries => new OutputNode.Folder(
                node.Metadata.Name,
                node.Metadata.Extension,
                node.Metadata.SizeBytes,
                node.Metadata.CreatedUtc,
                node.Metadata.ModifiedUtc,
                entries.Value.Select(Mirror).ToList()),

            // A LEAF, AT ANY DEPTH INCLUDING THE ROOT. The expander emits a bytes root for every
            // fetched file it does not recognise as an archive -- a CSV, an MP3, a PDF -- and those
            // bytes are the whole document. Mirroring one as a childless container is what silently
            // turned such a document into an empty zip.
            FileContent.Bytes bytes => new OutputNode.File(
                node.Metadata.Name, bytes.Value, node.Metadata.CreatedUtc, node.Metadata.ModifiedUtc),

            // An archive that expanded to nothing. Mirrored as a container with NULL children, which
            // the assembler emits as content: null -- the same representation it arrived in.
            _ => new OutputNode.Folder(
                node.Metadata.Name,
                node.Metadata.Extension,
                node.Metadata.SizeBytes,
                node.Metadata.CreatedUtc,
                node.Metadata.ModifiedUtc,
                null),
        };
}
