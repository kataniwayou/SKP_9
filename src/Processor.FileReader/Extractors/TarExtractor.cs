using System.Formats.Tar;

namespace Processor.FileReader.Extractors;

/// <summary>
/// Tar, on the in-box <c>System.Formats.Tar</c>. Uncompressed only — a <c>.tar.gz</c> has a
/// different extension and would need its own extractor and its own decision about whether the
/// double extension is one format or two.
/// </summary>
public sealed class TarExtractor : IArchiveExtractor
{
    public bool CanHandle(string extension)
        => ".tar".Equals(extension, StringComparison.OrdinalIgnoreCase);

    public IReadOnlyList<ExtractedEntry> Extract(Stream archive)
    {
        var entries = new List<ExtractedEntry>();

        // Counts every node TarReader actually yielded, before the type filter below drops any of
        // them. Deliberately separate from entries.Count — see the guard below for why the two
        // counts answer different questions and only one of them means "unreadable archive".
        var rawEntryCount = 0;

        // leaveOpen: true, unlike ZipExtractor's default false. The all-zero check below re-reads
        // this same stream after the reader is done with it (to tell a genuinely empty tar from a
        // corrupt one), which requires the stream to still be open at that point — ZipExtractor has
        // no equivalent second pass, so it can let ZipArchive close the stream on disposal.
        using (var reader = new TarReader(archive, leaveOpen: true))
        {
            while (reader.GetNextEntry() is { } entry)
            {
                rawEntryCount++;

                // Regular files only. TarEntryType also has ContiguousFile and SparseFile, both of
                // which can carry real content — GNU tar --sparse emits SparseFile — and both are
                // excluded here deliberately, not overlooked: this extractor's fixtures only ever
                // needed RegularFile/V7RegularFile, and widening the filter to the other two is a
                // considered follow-up, not a gap found by accident.
                if (entry.EntryType is not (TarEntryType.RegularFile or TarEntryType.V7RegularFile)
                    || entry.DataStream is null)
                {
                    continue;
                }

                using var buffer = new MemoryStream();
                entry.DataStream.CopyTo(buffer);

                entries.Add(new ExtractedEntry(
                    // The archive records a path; the node carries a name. A separator in a node
                    // name would read as structure the document does not have.
                    Path.GetFileName(entry.Name),
                    buffer.ToArray(),
                    // .UtcDateTime, not .DateTime or .LocalDateTime: ModificationTime is a
                    // DateTimeOffset, and only the UtcDateTime conversion yields DateTimeKind.Utc. A
                    // Local or Unspecified DateTime renders through System.Text.Json without the
                    // trailing Z (or with an offset instead), which fails the output schema one hop
                    // after this method returns — a branch where the failure is discarded rather
                    // than reported.
                    entry.ModificationTime.UtcDateTime));
            }
        }

        // Measured directly against this in-box reader (see task-6-report.md, fix round 1):
        // TarReader.GetNextEntry returns null — no exception at all — not only for a genuinely
        // empty tar (all-zero terminator blocks) but also for 0 bytes, a single 512-byte zero block,
        // and a 512-byte zero block followed by ~10 bytes of garbage. Only input that reaches far
        // enough to fail a field (a bad checksum, an unparsable number, a truncated read past the
        // first block) throws. So "zero entries" alone does not distinguish a healthy empty archive
        // from a corrupt one — a truncated or partially-zeroed file whose first block happens to be
        // zero would otherwise read as a healthy empty archive, which is exactly the false-HEALTHY
        // result this system's design rejects throughout.
        //
        // The check is "not all zero bytes", not "has any bytes" or a stricter POSIX two-block rule:
        // a genuinely empty archive IS all zero bytes (0 bytes and a lone zero block both satisfy
        // this, the former vacuously), and must still succeed.
        //
        // Gated on rawEntryCount, not entries.Count — fix round 2, after review caught the
        // regression this introduced. Those two counts answer different questions: rawEntryCount is
        // "did TarReader manage to read anything at all", which is the only question that means the
        // archive itself is unreadable; entries.Count is "did anything survive the regular-file
        // filter above", which a perfectly healthy directory-only, symlink-only, hardlink-only, or
        // sparse/contiguous-only archive can legitimately answer "no" to. Gating on entries.Count
        // made every one of those valid archives throw InvalidDataException — reporting a healthy
        // file as corrupt, which is worse than the empty-list result it replaced. Do not collapse
        // this back to entries.Count: that is exactly the "simplification" this comment exists to
        // head off.
        if (rawEntryCount == 0 && !IsAllZeroBytes(archive))
        {
            throw new InvalidDataException(
                "The tar produced no entries and is not all zero bytes — treating it as corrupt " +
                "rather than returning it as a healthy empty archive.");
        }

        return entries;
    }

    /// <summary>
    /// Re-reads the whole stream from the start. Only reached when TarReader yielded no nodes at
    /// all, so the extra pass costs nothing on the common path of an archive that actually has
    /// content — including an archive whose content is entirely nodes this extractor filters out.
    /// </summary>
    private static bool IsAllZeroBytes(Stream stream)
    {
        stream.Position = 0;
        var buffer = new byte[8192];
        int read;
        while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
        {
            for (var i = 0; i < read; i++)
            {
                if (buffer[i] != 0)
                {
                    return false;
                }
            }
        }

        return true;
    }
}
