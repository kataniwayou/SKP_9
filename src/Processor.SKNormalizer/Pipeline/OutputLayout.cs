namespace Processor.SKNormalizer;

/// <summary>
/// A node in the output tree a handler DESCRIBES. A handler never constructs a
/// <see cref="FileNode"/>: naming, extensions, sizes and counts belong to <c>TreeAssembler</c>.
/// </summary>
public abstract record OutputNode
{
    private OutputNode()
    {
    }

    /// <summary>
    /// A leaf. Its bytes are its content, whatever the extension claims.
    /// <para>
    /// <b>Both timestamps, not just one.</b> ArchiveExpander writes <c>createdUtc</c> and
    /// <c>modifiedUtc</c> on every node it emits; dropping either here would make the identity chain
    /// of Task 9 unpassable, and would quietly lose provenance for every real handler too.
    /// </para>
    /// </summary>
    public sealed record File(
        string Name, byte[] Content, DateTime? CreatedUtc, DateTime? ModifiedUtc) : OutputNode;

    /// <summary>
    /// A container.
    /// <para>
    /// <b><paramref name="ArchiveExtension"/> is required rather than optional, and that is the
    /// point.</b> ArchiveCollapser refuses an entries-bearing node whose extension names no writer,
    /// so making the extension unstateable-by-omission is what stops a handler expressing a document
    /// that cannot be collapsed. An extension naming no writer is retargeted by the assembler.
    /// </para>
    /// </summary>
    /// <param name="SizeBytes">
    /// <b>Carried, not computed.</b> This processor packs no archive, so a container has no built
    /// size — ArchiveExpander puts the source archive's byte length here and ArchiveCollapser
    /// recomputes it from what it actually packs. Summing children instead would be an invented
    /// number AND would break byte identity.
    /// </param>
    /// <param name="Name">The folder's name in the output tree.</param>
    /// <param name="ArchiveExtension">The extension the folder is repacked under.</param>
    /// <param name="CreatedUtc">Creation stamp carried from the source, or null.</param>
    /// <param name="ModifiedUtc">Modification stamp carried from the source, or null.</param>
    /// <param name="Children">
    /// <b>Null OR empty means "expanded to nothing", and both become <c>content: null</c></b> — not
    /// an empty array. The expander expresses an archive with no entries as null at every depth, so
    /// a container that changed representation on the way through would quietly break byte identity
    /// for any document holding a nested empty archive.
    /// </param>
    public sealed record Folder(
        string Name,
        string ArchiveExtension,
        long SizeBytes,
        DateTime? CreatedUtc,
        DateTime? ModifiedUtc,
        IReadOnlyList<OutputNode>? Children) : OutputNode;
}

/// <summary>
/// The whole output document: <b>a single root node, which may be a container or a leaf.</b>
/// <para>
/// <b>The root is an <see cref="OutputNode"/> rather than a name plus a child list, and that is the
/// fix for a defect that destroyed data.</b> ArchiveExpander emits a <c>Bytes</c> root for any
/// fetched file that is not a recognised archive — a CSV, an MP3, a PDF. The earlier shape could not
/// express that at all, so the mirror produced a container with no children and the assembler turned
/// it into an empty archive: the document's content was silently discarded, with no failed step.
/// Carrying a node makes the leaf-root shape expressible and makes "a root that is both a leaf and a
/// container" unrepresentable, rather than guarding against it.
/// </para>
/// </summary>
public sealed record OutputLayout(OutputNode Root);
