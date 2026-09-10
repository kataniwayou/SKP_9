using System.Formats.Tar;
using BclTarWriter = System.Formats.Tar.TarWriter;

namespace Processor.ArchiveCollapser.Writers;

/// <summary>
/// Tar, on the in-box <c>System.Formats.Tar</c>. Uncompressed only, mirroring <c>TarExtractor</c> --
/// a <c>.tar.gz</c> has a different extension and would need its own writer.
/// <para>
/// <b>The class name shadows <c>System.Formats.Tar.TarWriter</c></b>, which is the type it is built
/// on. The alias above resolves it in this one file; the name is kept for symmetry with
/// <c>ZipWriter</c> and with <c>TarExtractor</c> on the other side.
/// </para>
/// </summary>
public sealed class TarWriter : IArchiveWriter
{
    public string Extension => ".tar";

    public byte[] Write(IReadOnlyList<ArchiveEntry> entries)
    {
        try
        {
            return WriteCore(entries);
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException
                                      or NotSupportedException or ArgumentException
                                      or FormatException or EndOfStreamException)
        {
            // The same list TarExtractor wraps, for the same reason. FormatException is included
            // because System.Formats.Tar reports an unparsable octal field that way and it descends
            // from neither IOException nor ArgumentException.
            throw new ArchiveWritingException(ex.Message, ex);
        }
    }

    private static byte[] WriteCore(IReadOnlyList<ArchiveEntry> entries)
    {
        using var buffer = new MemoryStream();

        // PAX, AND THAT IS FORCED RATHER THAN AESTHETIC. TarExtractor.CanHandle requires the
        // "ustar" magic at byte 257 and explicitly refuses pre-POSIX V7, so a V7 archive would be
        // unrecognisable to our own expander and would come back as a leaf -- a silently broken
        // round trip rather than a failure. Pax also stores mtime at full precision, where Ustar is
        // limited to 11 octal digits of seconds, and writes TarEntryType.RegularFile, one of the two
        // types TarExtractor admits.
        //
        // leaveOpen so ToArray() below reads a live stream, matching ZipWriter.
        using (var tar = new BclTarWriter(buffer, TarEntryFormat.Pax, leaveOpen: true))
        {
            foreach (var entry in entries)
            {
                // A MemoryStream over an existing array holds no unmanaged resource, and TarWriter
                // does not take ownership -- so there is nothing here that must be disposed before
                // the archive is finished with it.
                var tarEntry = new PaxTarEntry(TarEntryType.RegularFile, entry.Name)
                {
                    // Null becomes the epoch: tar has no null, and the epoch is what TarExtractor
                    // reads back, which is what keeps collapse -> expand a fixed point. NOT clamped
                    // to 1980 like zip -- tar can represent what zip cannot, and the rule is to
                    // write the value the expander would read back, not the narrowest value any
                    // format could hold.
                    //
                    // MEASURED on .NET 8.0.31: PaxTarEntry.ModificationTime's setter throws
                    // ArgumentOutOfRangeException below DateTimeOffset.UnixEpoch (1970-01-01T00:00:00Z)
                    // -- 1969-01-01, 1900-01-01 and DateTimeOffset.MinValue all threw; the epoch
                    // itself and DateTimeOffset.MaxValue (9999-12-31T23:59:59.9999999Z) were both
                    // accepted unchanged. So the BCL's own floor already coincides with tar's null
                    // sentinel -- nothing below the epoch is representable here at all, which is why
                    // no separate clamp is needed beyond routing null to UnixEpoch: any ModifiedUtc
                    // this codebase can produce that is *at or above* the epoch passes straight
                    // through, and the one boundary case the tests probe (exactly 1970-01-01T00:00:00Z)
                    // sits ON the accepted floor rather than below it.
                    ModificationTime = entry.ModifiedUtc is { } stamp
                        ? new DateTimeOffset(DateTime.SpecifyKind(stamp, DateTimeKind.Utc))
                        : DateTimeOffset.UnixEpoch,
                    DataStream = new MemoryStream(entry.Content, writable: false),
                };

                tar.WriteEntry(tarEntry);
            }
        }

        // MEASURED: disposing a BclTarWriter with zero entries written produces a 0-byte stream --
        // no trailing zero blocks at all, unlike a genuinely-terminated tar. TarExtractor's
        // IsAllZeroBytes guard calls 0 bytes "all zero" vacuously, so this still lands on the
        // healthy-empty-archive branch rather than the corrupt one; a document with content:null
        // needs no special case here, matching ZipWriter's empty-list comment.
        return buffer.ToArray();
    }
}
