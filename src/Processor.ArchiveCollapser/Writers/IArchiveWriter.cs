namespace Processor.ArchiveCollapser.Writers;

/// <summary>One entry to place in an archive.</summary>
/// <param name="Name">The entry's file name. Never a path -- ArchiveBuilder rejects a separator.</param>
/// <param name="Content">The entry's bytes, written verbatim.</param>
/// <param name="ModifiedUtc">Null where the source document recorded none.</param>
public sealed record ArchiveEntry(string Name, byte[] Content, DateTime? ModifiedUtc);

/// <summary>
/// One archive format. Registered in the container and selected by the node's DECLARED EXTENSION.
/// <para>
/// <b>There is no <c>CanHandle</c>, and that asymmetry with <c>IArchiveExtractor</c> is the whole
/// point.</b> On the way in the bytes exist and are the only honest evidence -- an entry's name is
/// written by whoever built the archive. On the way out there are no bytes yet. The only thing a
/// node carries about what it should BECOME is its declared name, so the name must decide, at every
/// level.
/// </para>
/// <para>
/// <b>There is no RAR implementation and there cannot be one.</b> The format is proprietary and
/// SharpCompress -- the package ArchiveExpander uses to read it -- exposes no writer. A <c>.rar</c>
/// node holding entries is a failed step; see <c>ArchiveBuilder.NoWriter</c>.
/// </para>
/// </summary>
public interface IArchiveWriter
{
    /// <summary>The extension this writer claims, leading dot -- <c>".zip"</c>. The SELECTOR.</summary>
    string Extension { get; }

    /// <summary>
    /// The archive's bytes, or an <see cref="ArchiveWritingException"/> saying why they could not be
    /// produced. An empty list must produce the format's own canonical empty archive rather than
    /// throwing: an archive that expanded to nothing is a legitimate document.
    /// </summary>
    byte[] Write(IReadOnlyList<ArchiveEntry> entries);
}
