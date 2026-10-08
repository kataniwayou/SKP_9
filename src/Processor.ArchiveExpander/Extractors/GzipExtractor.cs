using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;
using Microsoft.Extensions.Options;

namespace Processor.ArchiveExpander.Extractors;

/// <summary>
/// Gzip, on the in-box <c>System.IO.Compression</c>. No package.
/// <para>
/// <b>Gzip compresses one file; it is not a container.</b> So this always yields exactly one entry —
/// the decompressed bytes — and a <c>.tar.gz</c> is two formats, not one: this extractor yields the
/// tar, and the next level down claims it by signature like any other nested archive. That is the
/// decision <see cref="TarExtractor"/>'s summary left open, settled by the recursion that already
/// exists rather than by a combined extractor. A <c>.tar.gz</c> therefore needs <c>MaxDepth</c> 2 to
/// reach the tar's entries.
/// </para>
/// <para>
/// <b>There is no false-HEALTHY "zero entries" case here</b>, unlike zip, tar and rar — one entry is
/// produced or the extraction throws. The hole this format has instead is TRUNCATION reading as a
/// shorter file, which is what <see cref="ExtractCore"/>'s trailer check closes.
/// </para>
/// </summary>
public sealed class GzipExtractor(IOptions<ArchiveExpanderOptions> options) : IArchiveExtractor
{
    // Header flag bits, RFC 1952 §2.3.1. FTEXT, FHCRC and FCOMMENT are not named: they follow the
    // name or change nothing about the content, and GZipStream reads past them itself.
    private const byte FlagExtra = 0x04;
    private const byte FlagName = 0x08;

    /// <summary>ID1 ID2 CM — the fixed header, then the flag byte, MTIME, XFL and OS.</summary>
    private const int FixedHeaderLength = 10;

    /// <summary>CRC32 and ISIZE, each four bytes little-endian.</summary>
    private const int TrailerLength = 8;

    // The pod's ceiling, applied here as well as in FileContentBuilder's budget. See Extract for why
    // gzip in particular cannot leave it to the budget alone.
    private readonly long _maxExpandedBytes = options.Value.MaxExpandedBytes;

    public string Extension => ".gz";

    /// <summary>
    /// <c>\x1F\x8B</c> then compression method <c>\x08</c> (deflate), the only method RFC 1952
    /// defines. Three bytes, not the full ten-byte header: a three-byte file that starts this way is
    /// a truncated gzip, and claiming it is what lets it fail as corrupt rather than pass as a leaf.
    /// </summary>
    public bool CanHandle(ReadOnlySpan<byte> header)
        => header.Length >= 3 && header[0] == 0x1F && header[1] == 0x8B && header[2] == 0x08;

    /// <summary>
    /// The one decompressed file, or an <see cref="ArchiveExtractionException"/> saying why it could
    /// not be read.
    /// <para>
    /// <b>The ceiling is enforced DURING decompression, not after.</b> Every other extractor
    /// materialises its entries before <c>FileContentBuilder</c>'s budget sees them — the residual its
    /// <c>ExpansionBudget</c> summary records. For zip and tar that residual is bounded by ordinary
    /// ratios; for gzip it is not: deflate reaches ~1000:1, so a 32 MiB file admitted upstream could
    /// demand ~32 GB here, and an OOM is a poison message, not a failed step. Stopping the copy at the
    /// ceiling turns that into the same acked failure the budget gives.
    /// </para>
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

    private List<ExtractedEntry> ExtractCore(Stream archive)
    {
        var (name, modifiedUtc) = ReadHeader(archive);

        archive.Position = 0;

        using var buffer = new MemoryStream();

        // leaveOpen: true, because the trailer check below re-reads the same stream.
        using (var gzip = new GZipStream(archive, CompressionMode.Decompress, leaveOpen: true))
        {
            CopyBounded(gzip, buffer);
        }

        // THE TRUNCATION GUARD. ISIZE is the uncompressed length mod 2^32, the last four bytes of
        // the file. Checking it against what was actually produced catches a file cut short at a
        // deflate block boundary, which a decompressor can otherwise end cleanly as a shorter file.
        //
        // Concatenated members are legal and GZipStream decompresses all of them, but ISIZE is the
        // LAST member's alone — so the check is only exact for a single member, and a multi-member
        // file is held to "the produced length is at least the last member's". Nothing in this system
        // writes one; the weaker check is recorded rather than papered over.
        //
        // No mod-2^32 arithmetic is needed: the ceiling keeps every buffer here far below 4 GiB.
        var declared = ReadDeclaredSize(archive);

        if (buffer.Length < declared)
        {
            throw new ArchiveExtractionException(
                $"the gzip trailer declares {declared} bytes and {buffer.Length} were decompressed — "
                + "treating it as truncated rather than returning a shorter file");
        }

        return [new ExtractedEntry(name, buffer.ToArray(), modifiedUtc)];
    }

    /// <summary>
    /// Copies at most the ceiling, and throws the moment it is crossed rather than after the whole
    /// stream has been inflated into memory.
    /// </summary>
    private void CopyBounded(Stream source, MemoryStream destination)
    {
        var chunk = new byte[81920];
        int read;

        while ((read = source.Read(chunk, 0, chunk.Length)) > 0)
        {
            if (destination.Length + read > _maxExpandedBytes)
            {
                throw new ArchiveExtractionException(
                    $"the gzip expands to more than the {_maxExpandedBytes} byte ceiling "
                    + "that bounds the expansion as well as the file");
            }

            destination.Write(chunk, 0, read);
        }
    }

    /// <summary>
    /// The recorded file name and modification time, from the RFC 1952 header.
    /// <para>
    /// <b>The name is optional in the format</b> — <c>gzip -n</c> and most library writers omit it,
    /// .NET's own <c>GZipStream</c> included. An empty name is returned then, and
    /// <c>FileContentBuilder</c> gives the entry the archive's own name less its extension, which is
    /// what <c>gunzip</c> itself does.
    /// </para>
    /// </summary>
    private static (string Name, DateTime? ModifiedUtc) ReadHeader(Stream archive)
    {
        archive.Position = 0;

        Span<byte> fixedHeader = stackalloc byte[FixedHeaderLength];
        if (archive.ReadAtLeast(fixedHeader, FixedHeaderLength, throwOnEndOfStream: false)
            < FixedHeaderLength)
        {
            throw new ArchiveExtractionException(
                "the gzip is shorter than its ten-byte header — treating it as truncated");
        }

        var flags = fixedHeader[3];

        // MTIME is Unix seconds; zero means none was recorded, not 1970.
        var mtime = BinaryPrimitives.ReadUInt32LittleEndian(fixedHeader[4..8]);
        DateTime? modifiedUtc = mtime == 0 ? null : DateTime.UnixEpoch.AddSeconds(mtime);

        if ((flags & FlagExtra) != 0)
        {
            Span<byte> length = stackalloc byte[2];
            archive.ReadExactly(length);
            archive.Seek(BinaryPrimitives.ReadUInt16LittleEndian(length), SeekOrigin.Current);
        }

        var name = (flags & FlagName) != 0 ? ReadZeroTerminated(archive) : string.Empty;

        // The header records a path on some writers; the node carries a name. A separator in a node
        // name would read as structure the document does not have.
        return (Path.GetFileName(name), modifiedUtc);
    }

    /// <summary>A zero-terminated ISO 8859-1 string, as RFC 1952 defines FNAME.</summary>
    private static string ReadZeroTerminated(Stream archive)
    {
        var bytes = new List<byte>();
        int b;

        while ((b = archive.ReadByte()) > 0)
        {
            bytes.Add((byte)b);
        }

        if (b < 0)
        {
            throw new ArchiveExtractionException(
                "the gzip header's file name runs past the end of the file — treating it as truncated");
        }

        return Encoding.Latin1.GetString(bytes.ToArray());
    }

    private static uint ReadDeclaredSize(Stream archive)
    {
        if (archive.Length < FixedHeaderLength + TrailerLength)
        {
            throw new ArchiveExtractionException(
                "the gzip is too short to hold its eight-byte trailer — treating it as truncated");
        }

        archive.Position = archive.Length - 4;
        Span<byte> size = stackalloc byte[4];
        archive.ReadExactly(size);

        return BinaryPrimitives.ReadUInt32LittleEndian(size);
    }
}
