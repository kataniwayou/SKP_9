using SharpCompress.Archives;
using SharpCompress.Archives.Rar;

namespace Processor.FileReader.Extractors;

/// <summary>
/// Rar, on SharpCompress — the only extractor here that needs a package, because .NET ships no rar
/// reader and there is no writing one either.
/// <para>
/// <b>Read-only, and that is the format's limit rather than this class's.</b> SharpCompress does not
/// write rar. Nothing here needs to; it is why the test fixture is a committed binary.
/// </para>
/// <para>
/// <b>Solid archives are only partly supported by the library.</b> A solid rar stores entries as one
/// compressed stream, so random access to a single entry is not always possible. This class reads
/// every entry in order, which is the access pattern that works — but an archive the library cannot
/// read throws, and the processor reports it as an unextractable file rather than a partial success.
/// </para>
/// <para>
/// <b>No false-HEALTHY guard, unlike <see cref="TarExtractor"/>.</b> Tar's near miss was
/// <c>TarReader.GetNextEntry</c> returning null with no exception for a truncated-right-after-a-
/// zeroed-header file, making a corrupt archive read as a healthy empty one. Measured directly
/// against this library before writing this class (see task-7-report.md): <c>RarArchive.Open</c>
/// itself — before this method ever reaches the <c>Entries</c> enumeration below — throws
/// <c>InvalidFormatException</c> for an empty stream, for a few bytes of garbage, for a block of
/// all-zero bytes the same length as the fixture, and for the real fixture truncated to its first
/// 100 bytes. Every corrupt shape tried fails at open, so there is no gap for a corrupt archive to
/// fall through as an empty one, and no equivalent guard belongs here.
/// </para>
/// </summary>
public sealed class RarExtractor : IArchiveExtractor
{
    public bool CanHandle(string extension)
        => ".rar".Equals(extension, StringComparison.OrdinalIgnoreCase);

    public IReadOnlyList<ExtractedEntry> Extract(Stream archive)
    {
        using var rar = RarArchive.Open(archive);

        var entries = new List<ExtractedEntry>();

        foreach (var entry in rar.Entries)
        {
            // Directories carry no content and no node, matching zip and tar.
            if (entry.IsDirectory || entry.Key is null)
            {
                continue;
            }

            using var stream = entry.OpenEntryStream();
            using var buffer = new MemoryStream();
            stream.CopyTo(buffer);

            entries.Add(new ExtractedEntry(
                // Key is a path within the archive. The node carries a name, as with tar.
                Path.GetFileName(entry.Key),
                // MemoryStream.ToArray() never returns null, so Content is never null here — the
                // record's constructor takes a non-nullable byte[], and FileContentBuilder.Leaf
                // dereferences it unguarded.
                buffer.ToArray(),
                // LastModifiedTime is a DateTime?, not a DateTimeOffset like Zip's LastWriteTime or
                // Tar's ModificationTime — SharpCompress has no offset to give for rar. Measured
                // directly against this fixture (see task-7-report.md): the Kind SharpCompress hands
                // back is Local, not Unspecified — WinRAR records wall-clock time with no timezone,
                // and SharpCompress marks the DateTime it constructs as this machine's local time.
                // .ToUniversalTime() on a Local value converts using that offset and returns
                // DateTimeKind.Utc, which is what this class must produce: System.Text.Json renders
                // a Local or Unspecified DateTime without the trailing Z (or with an offset instead),
                // failing the output schema one hop after this method returns — a branch where the
                // failure is discarded rather than reported. Had the measured Kind instead come back
                // Unspecified, this same call would still be correct: .NET's ToUniversalTime treats
                // Unspecified identically to Local.
                entry.LastModifiedTime?.ToUniversalTime()));
        }

        return entries;
    }
}
