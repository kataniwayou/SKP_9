using System.IO.Compression;

namespace Processor.FileReader.Extractors;

/// <summary>
/// Zip, on the in-box <c>System.IO.Compression</c>. No package.
/// <para>
/// <b>The false-HEALTHY guard is here too, and it was added last.</b> This class predates the lesson
/// tar and rar each learned — a library will open a damaged archive, report success, and enumerate
/// nothing, so a corrupt file reads as a healthy <i>empty</i> archive and the step reports Completed
/// over <c>{content: null, entries: [], entryCount: 0}</c>. Zip was written before that and was not
/// revisited; see the guard below for what was measured on this runtime and what was not.
/// </para>
/// </summary>
public sealed class ZipExtractor : IArchiveExtractor
{
    /// <summary>The canonical empty archive: an EOCD record and nothing else.</summary>
    private const int EmptyArchiveLength = 22;

    /// <summary>
    /// <c>PK\x05\x06</c> — the End Of Central Directory signature, which in a 22-byte file is the
    /// whole file.
    /// </summary>
    private static ReadOnlySpan<byte> EndOfCentralDirectorySignature => [0x50, 0x4B, 0x05, 0x06];

    public bool CanHandle(string extension)
        => ".zip".Equals(extension, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Every file entry, one level deep, or an <see cref="ArchiveExtractionException"/> saying why
    /// the archive could not be read.
    /// </summary>
    public IReadOnlyList<ExtractedEntry> Extract(Stream archive)
    {
        try
        {
            return ExtractCore(archive);
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException
                                      or NotSupportedException or ArgumentException)
        {
            // The BCL fault types System.IO.Compression raises, wrapped into the one type the
            // processor catches. Not bare Exception: a NullReferenceException here is a bug in this
            // class, and it must reach the framework's general catch with its stack trace rather
            // than be reported to an operator as a corrupt file.
            throw new ArchiveExtractionException(ex.Message, ex);
        }
    }

    private static List<ExtractedEntry> ExtractCore(Stream archive)
    {
        var entries = new List<ExtractedEntry>();

        // Counts every entry ZipArchive actually yielded, BEFORE the directory filter below drops
        // any of them — the same split TarExtractor and RarExtractor make, and for the same reason.
        // Gating the guard on entries.Count instead would report a valid directory-only zip as
        // corrupt, which is the regression fix round 2 caught in tar.
        var rawEntryCount = 0;

        // leaveOpen: true, unlike the plain constructor this class used before. The empty-archive
        // exemption below re-reads this same stream after the archive is done with it, which
        // requires the stream to still be open at that point.
        using (var zip = new ZipArchive(archive, ZipArchiveMode.Read, leaveOpen: true))
        {
            foreach (var entry in zip.Entries)
            {
                rawEntryCount++;

                // A directory is a zero-length entry whose name ends in a slash. Skipped rather than
                // represented: it carries no content, and counting it would make entryCount disagree
                // with the nodes a reader actually sees.
                if (entry.FullName.EndsWith('/') || entry.Name.Length == 0)
                {
                    continue;
                }

                using var stream = entry.Open();
                using var buffer = new MemoryStream();
                stream.CopyTo(buffer);

                // entry.Name, not FullName: the directory a zip recorded is not part of the entry's
                // identity here, and a path separator in a node name would read as structure the
                // document does not have.
                //
                // .UtcDateTime, not .DateTime or .LocalDateTime: LastWriteTime is a DateTimeOffset,
                // and only the UtcDateTime conversion yields DateTimeKind.Utc. System.Text.Json
                // renders a Local or Unspecified DateTime without the trailing Z (or with an offset
                // instead), which fails the output schema one hop after this method returns — a
                // branch where the failure is discarded rather than reported.
                entries.Add(new ExtractedEntry(
                    entry.Name, buffer.ToArray(), entry.LastWriteTime.UtcDateTime));
            }
        }

        // THE FALSE-HEALTHY GUARD, matching tar's shape rather than rar's — a genuinely empty zip is
        // a real, valid file and must still succeed, so this needs an exemption where rar does not.
        //
        // WHAT WAS MEASURED, on .NET 8.0.31, against a real 221-byte two-entry zip built in a scratch
        // program (not a hand-typed blob), before this guard was written:
        //
        //  - Truncation at every length 1..220 throws. So does every 1/2/4/8/16/32/64/97-byte window
        //    zeroed or 0xFF-filled at every offset before the EOCD, every zeroing of the whole
        //    central directory, every zeroing of everything before the EOCD, and 1..64 bytes of
        //    padding prepended or appended. ~2200 mutations, ZERO of which opened with zero entries:
        //    this runtime DOES cross-check the EOCD's declared entry count against what the central
        //    directory actually yielded, and says so by name.
        //  - It cross-checks the count, and NOT the central directory's declared size and offset.
        //    Zero the EOCD's entry-count AND its central-directory size/offset fields — twelve bytes,
        //    the shape a partially-flushed write or a padded transfer produces at the tail — and the
        //    221-byte file with both of its entries still in it opens cleanly and enumerates NOTHING,
        //    with no exception. That is the hole, reproduced, and it is what the test pins.
        //
        // The guard covers the CLASS, not that one byte pattern: any damage that opens successfully
        // and yields nothing is caught however it arose, on this runtime version or a later one whose
        // internal cross-checks differ again. What remains unguarded is a nonzero but wrong count —
        // three entries silently becoming two — because nothing in a zip states how many there should
        // have been.
        if (rawEntryCount == 0 && !IsCanonicalEmptyArchive(archive))
        {
            throw new ArchiveExtractionException(
                "The zip produced no entries and is not the canonical 22-byte empty archive — " +
                "treating it as corrupt rather than returning it as a healthy empty archive.");
        }

        return entries;
    }

    /// <summary>
    /// True for the one zip that legitimately yields nothing: a bare End Of Central Directory record
    /// with no entries and no comment, which is exactly 22 bytes beginning <c>PK\x05\x06</c>.
    /// <para>
    /// <b>The shape was verified rather than assumed</b> — a <c>ZipArchive</c> opened in
    /// <c>Create</c> mode and closed without a single entry writes precisely those 22 bytes on .NET
    /// 8.0.31, checked in the same scratch program that found the hole above.
    /// </para>
    /// <para>
    /// This is deliberately narrower than "no entries and a plausible EOCD". A zip longer than 22
    /// bytes has something in it — local file records, a central directory, or padding — and a file
    /// with content that enumerates to nothing is the corrupt case, not the empty one. A valid empty
    /// zip carrying an archive comment would be rejected by this, and that is accepted: nothing in
    /// this system writes one, and admitting a variable-length tail would reopen the door the guard
    /// closes.
    /// </para>
    /// </summary>
    private static bool IsCanonicalEmptyArchive(Stream stream)
    {
        // A stream that cannot seek cannot be re-read, so the exemption cannot be established and
        // the archive is treated as corrupt. Every caller here hands over a seekable MemoryStream or
        // FileStream; this is the safe answer for one that does not, because falsely claiming
        // "empty" is the failure mode this whole guard exists to prevent.
        if (!stream.CanSeek || stream.Length != EmptyArchiveLength)
        {
            return false;
        }

        stream.Position = 0;
        Span<byte> head = stackalloc byte[4];
        stream.ReadExactly(head);

        return head.SequenceEqual(EndOfCentralDirectorySignature);
    }
}
