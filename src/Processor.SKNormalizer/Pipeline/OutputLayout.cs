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
    public sealed record Folder(
        string Name,
        string ArchiveExtension,
        long SizeBytes,
        DateTime? CreatedUtc,
        DateTime? ModifiedUtc,
        IReadOnlyList<OutputNode> Children) : OutputNode;
}

/// <summary>
/// The whole output document. <paramref name="Children"/> null means "expanded to nothing" and
/// becomes <c>content: null</c> — NOT an empty array, matching how the expander expresses it.
/// The root's size and timestamps are carried for the reason <see cref="OutputNode.Folder"/> records.
/// </summary>
public sealed record OutputLayout(
    string RootName,
    string RootExtension,
    long SizeBytes,
    DateTime? CreatedUtc,
    DateTime? ModifiedUtc,
    IReadOnlyList<OutputNode>? Children);
