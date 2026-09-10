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
            //
            // Not bare Exception: a NullReferenceException here is a bug in this class, and it must
            // reach the framework's general catch with its stack trace rather than be reported to an
            // operator as a bad document.
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
                    ModificationTime = ModificationTime(entry.ModifiedUtc),
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

    /// <summary>
    /// The timestamp to store, per the same rule <c>ZipWriter.Clamp</c> follows: write the value the
    /// expander would read back.
    /// <para>
    /// Null becomes the epoch: tar has no null, and the epoch is what <c>TarExtractor</c> reads
    /// back, which is what keeps collapse -&gt; expand a fixed point.
    /// </para>
    /// <para>
    /// <b>Above the epoch, this does NOT clamp to 1980 like zip</b> -- tar can represent what zip
    /// cannot, and a value like 1975 passes straight through unclamped: the rule is to write the
    /// value the expander would read back, not the narrowest value any format could hold.
    /// </para>
    /// <para>
    /// <b>Below the epoch, though, this DOES clamp -- and that is a .NET WRITER bound, not a tar
    /// FORMAT bound.</b> MEASURED on .NET 8.0.31: <c>PaxTarEntry.ModificationTime</c>'s setter throws
    /// <see cref="ArgumentOutOfRangeException"/> for anything before <see
    /// cref="DateTimeOffset.UnixEpoch"/> (1970-01-01T00:00:00Z) -- 1969-01-01, 1900-01-01 and
    /// <see cref="DateTimeOffset.MinValue"/> all threw; the epoch itself and
    /// <see cref="DateTimeOffset.MaxValue"/> (9999-12-31T23:59:59.9999999Z) were both accepted
    /// unchanged. The tar FORMAT and the in-box <c>TarReader</c> do NOT share this limit -- a
    /// hand-built PAX archive carrying a negative mtime extended record (GNU tar's own encoding for
    /// a pre-1970 file) was read back by <c>TarReader</c> as 1969-12-31T00:00:00Z with no exception,
    /// so <c>ArchiveExpander</c> can and does hand this writer a below-epoch <c>ModifiedUtc</c>; this
    /// is demonstrated reachable, not a theoretical edge.
    /// </para>
    /// <para>
    /// Refusing to write it (letting the setter throw) would not preserve the timestamp -- it was
    /// already committed upstream by the expander -- it would only lose the timestamp AND the whole
    /// archive, recovering neither. Clamping to the epoch loses just the one field, and keeps the
    /// governing rule true at this boundary too: after the clamp, the epoch IS the value
    /// <c>TarExtractor</c> reads back. This mirrors <c>ZipWriter.Clamp</c>, which already clamps to a
    /// writer/format bound rather than pretending the bound does not exist.
    /// </para>
    /// </summary>
    private static DateTimeOffset ModificationTime(DateTime? modifiedUtc)
    {
        if (modifiedUtc is not { } stamp)
        {
            return DateTimeOffset.UnixEpoch;
        }

        var offset = new DateTimeOffset(DateTime.SpecifyKind(stamp, DateTimeKind.Utc));
        return offset < DateTimeOffset.UnixEpoch ? DateTimeOffset.UnixEpoch : offset;
    }
}
