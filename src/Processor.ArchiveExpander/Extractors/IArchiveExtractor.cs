namespace Processor.ArchiveExpander.Extractors;

/// <summary>One entry pulled out of an archive.</summary>
/// <param name="Name">The entry's own file name, without any directory the archive recorded.</param>
/// <param name="ModifiedUtc">Null where the format records none.</param>
public sealed record ExtractedEntry(string Name, byte[] Content, DateTime? ModifiedUtc);

/// <summary>
/// One archive format. Registered in the container and resolved by the file's own leading bytes, so
/// adding a format is one class and one registration.
/// </summary>
public interface IArchiveExtractor
{
    /// <summary>
    /// The extension a file of this format is normally named with, leading dot — <c>".zip"</c>.
    /// <para>
    /// <b>This is NOT how the extractor is chosen.</b> <see cref="CanHandle"/> does that, from the
    /// bytes. This exists for one narrower job, at the top level only: telling a file whose name
    /// declares an archive, and whose bytes are not one, from an ordinary file.
    /// </para>
    /// <para>
    /// <b>Without it, corruption reads as success.</b> A <c>.zip</c> whose header is damaged matches
    /// no signature, so signature-only dispatch would make it a leaf carrying its raw bytes and the
    /// step would report Completed over a file nobody could open — precisely the false-HEALTHY
    /// failure the guards inside each extractor exist to prevent, arrived at from outside them. The
    /// top-level file is the one place a DECLARATION exists to cross-check against, because
    /// <c>ArchiveExpanderConfig.ExpectedExtension</c> already had to match it for the file to be admitted
    /// at all. Nested entries have no declaration and get no such check.
    /// </para>
    /// </summary>
    string Extension { get; }

    /// <summary>
    /// True when these bytes are this extractor's format, judged by the format's signature.
    /// <para>
    /// <b>The BYTES decide, not the name — and that is a deliberate reversal.</b> This was
    /// <c>CanHandle(string extension)</c>, resolved against <c>ArchiveExpanderConfig.ExpectedExtension</c>.
    /// That worked only because the top-level file has a declared extension the processor had
    /// already validated. Nested entries have no declaration: an entry's name is a string written by
    /// whoever built the archive, and below the first level there is nothing to check it against. So
    /// the two jobs are split — <c>ExpectedExtension</c> ADMITS a file to the step, and the
    /// signature CHOOSES the extractor — and the second one works at every depth for the same
    /// reason.
    /// </para>
    /// <para>
    /// <b>What this costs: a mismatch is no longer a fault.</b> A file named <c>.zip</c> that is
    /// really a tar used to reach <c>ZipExtractor</c> and throw. It now extracts as a tar. The
    /// admission check still refuses a file whose extension is not what the step named, so the
    /// disagreement that remains is between a name the step approved and the content behind it —
    /// and reading the content is the more useful answer of the two.
    /// </para>
    /// <para>
    /// <b>No match is the ordinary case, not a fault.</b> A CSV matches nothing, and that is exactly
    /// how the expansion terminates: a node whose bytes match no extractor is a leaf.
    /// </para>
    /// </summary>
    /// <param name="header">
    /// The candidate's bytes, or as many as exist. Implementations must tolerate a buffer shorter
    /// than the signature they look for and answer false rather than throw — a two-byte file is a
    /// legitimate leaf, not a malformed archive.
    /// </param>
    bool CanHandle(ReadOnlySpan<byte> header);

    /// <summary>
    /// Every entry, one level deep. Directories are skipped rather than represented — an empty
    /// directory carries no content and no metadata worth a node. Depth beyond one is the caller's
    /// job: this seam expands exactly the archive it is handed.
    /// </summary>
    IReadOnlyList<ExtractedEntry> Extract(Stream archive);
}
