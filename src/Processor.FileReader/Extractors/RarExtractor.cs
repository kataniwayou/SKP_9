using SharpCompress.Archives;
using SharpCompress.Archives.Rar;
using SharpCompress.Common;

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
/// <b>The false-HEALTHY hole IS present here, same class as Tar's.</b> Fix round 1 measured this
/// directly by truncating the committed fixture byte by byte (see task-7-fix-round-1-report.md):
/// most short truncations throw out of <c>RarArchive.Open</c> or out of the <c>Entries</c>
/// enumeration, but two windows do not — truncated to 8-11 bytes (just past the RAR5 signature) or
/// to 23-26 bytes (just past the main archive header, before the first file header) both open
/// successfully and enumerate zero entries with no exception anywhere. An earlier round of this
/// class tried only an empty stream, garbage bytes, an all-zero block, and a 100-byte truncation —
/// all well outside this narrow window — and wrongly concluded no guard was needed. That was a gap
/// in what was tried, not a property of the library: do not trust "every shape I tried throws" as
/// a proof that no shape exists that doesn't.
/// </para>
/// </summary>
public sealed class RarExtractor : IArchiveExtractor
{
    public bool CanHandle(string extension)
        => ".rar".Equals(extension, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Every file entry, one level deep, or an <see cref="ArchiveExtractionException"/> saying why
    /// the archive could not be read.
    /// <para>
    /// <b>The wrapping is not decoration; it is the fix for a measured seam failure.</b> Every
    /// SharpCompress fault descends from <c>SharpCompress.Common.SharpCompressException :
    /// System.Exception</c> — <c>InvalidFormatException</c>, <c>ArchiveException</c>,
    /// <c>IncompleteArchiveException</c> and the rest — and none of them is an
    /// <see cref="InvalidDataException"/>, an <see cref="IOException"/>, a
    /// <see cref="NotSupportedException"/> or an <see cref="ArgumentException"/>, which is what the
    /// processor's catch list held when this class was added. So an ordinary corrupt rar failed the
    /// step through the framework's general catch instead, with the file path in no line of it. Only
    /// the two narrow truncation windows that trip this class's OWN guard ever produced the
    /// contract's <c>extracting {FilePath} failed:</c> message.
    /// </para>
    /// </summary>
    public IReadOnlyList<ExtractedEntry> Extract(Stream archive)
    {
        try
        {
            return ExtractCore(archive);
        }
        catch (SharpCompressException ex)
        {
            // The library's own root type, so every present and future SharpCompress fault is
            // covered by one clause rather than by a list that must be revisited whenever the
            // package is upgraded. This is the only place in this project that names a SharpCompress
            // type; the processor stays free of the package entirely, which is the point.
            throw new ArchiveExtractionException(ex.Message, ex);
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException
                                      or NotSupportedException or ArgumentException
                                      or EndOfStreamException)
        {
            // SharpCompress does not wrap everything it touches: a stream read that fails, or an
            // argument it rejects before its own validation runs, still surfaces as a BCL type.
            //
            // Not bare Exception: a NullReferenceException here is a bug in this class, and it must
            // reach the framework's general catch with its stack trace rather than be reported to an
            // operator as a corrupt file.
            throw new ArchiveExtractionException(ex.Message, ex);
        }
    }

    private static List<ExtractedEntry> ExtractCore(Stream archive)
    {
        using var rar = RarArchive.Open(archive);

        var entries = new List<ExtractedEntry>();

        // Counts every entry rar.Entries actually yielded, before the directory/null-key filter
        // below drops any of them — the same split TarExtractor makes, and for the same reason.
        // Gating the guard below on entries.Count instead would throw on a valid directory-only
        // (or, here, entirely-directories) rar, which is a healthy archive with legitimately zero
        // file nodes. See TarExtractor.Extract's guard comment for the fuller account of that
        // regression; it applies unchanged to this class.
        var rawEntryCount = 0;

        foreach (var entry in rar.Entries)
        {
            rawEntryCount++;

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
                //
                // KNOWN LIMITATION, not fixable from here: a plain rar timestamp carries no timezone
                // at all, so a rar built on a machine in a different timezone than this one produces
                // a ModifiedUtc that is wrong by that offset — there is no information left in the
                // format to recover the true instant. RAR5 defines an optional UTC-flagged extended-
                // time field that would sidestep this, but this fixture (built by a plain WinRAR
                // `a` command) does not carry it, and SharpCompress's LastModifiedTime does not
                // expose whether it was present. This is a format/library ceiling, not a bug here.
                entry.LastModifiedTime?.ToUniversalTime()));
        }

        // Fix round 1: measured directly against this library by truncating the real committed
        // fixture byte by byte (see task-7-fix-round-1-report.md). Two windows open successfully via
        // RarArchive.Open and then enumerate zero entries with no exception anywhere in the loop
        // above: truncated to 8-11 bytes (just past the RAR5 signature, before the main archive
        // header is complete) and truncated to 23-26 bytes (just past the main archive header,
        // before the first file header). Both are ordinary corruption — a transfer or write cut off
        // in the first ~30 bytes — and both would otherwise read as a healthy empty archive, exactly
        // the class of false-HEALTHY result Task 6 found in TarReader.
        //
        // Unlike TarExtractor, there is no "all zero bytes is a legitimately empty archive" case to
        // exempt: an all-zero stream and an empty stream both already fail at RarArchive.Open above
        // (measured in task-7-report.md), and a rar with a valid, fully-read signature and header
        // always carries at least an end-of-archive record — SharpCompress has no path that yields a
        // genuinely empty rar with rawEntryCount == 0. So this guard is unconditional: any zero raw
        // yield is corruption, full stop. If a genuinely empty-but-valid rar is ever found that this
        // rejects, that is new information this comment does not currently have — stop and report it
        // rather than loosening this check to guess at what such an archive would look like.
        if (rawEntryCount == 0)
        {
            // ArchiveExtractionException, not InvalidDataException as this originally threw. The
            // type is now the seam's, not the BCL's — see TarExtractor's matching guard.
            throw new ArchiveExtractionException(
                "The rar produced no entries even though it opened successfully — treating it as " +
                "corrupt rather than returning it as a healthy empty archive.");
        }

        return entries;
    }
}
