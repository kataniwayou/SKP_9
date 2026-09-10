using System.IO.Compression;

namespace Processor.ArchiveCollapser.Writers;

/// <summary>
/// Zip, on the in-box <c>System.IO.Compression</c>. No package. The mirror of <c>ZipExtractor</c>.
/// </summary>
public sealed class ZipWriter : IArchiveWriter
{
    /// <summary>
    /// The DOS date range <c>ZipArchiveEntry.LastWriteTime</c> accepts. Outside it the setter throws
    /// <see cref="ArgumentOutOfRangeException"/>, so both ends are clamped rather than passed
    /// through -- see <see cref="Clamp"/> for why the floor in particular is the RIGHT answer and
    /// not merely a safe one.
    /// </summary>
    private static readonly DateTime DosFloor = new(1980, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    /// <summary>23:59:58, not :59 -- DOS stores seconds in two-second units.</summary>
    private static readonly DateTime DosCeiling = new(2107, 12, 31, 23, 59, 58, DateTimeKind.Utc);

    public string Extension => ".zip";

    public byte[] Write(IReadOnlyList<ArchiveEntry> entries)
    {
        try
        {
            return WriteCore(entries);
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException
                                      or NotSupportedException or ArgumentException)
        {
            // The BCL fault types System.IO.Compression raises, wrapped into the one type the
            // processor catches. ArgumentOutOfRangeException descends from ArgumentException, so a
            // bug in Clamp degrades to a clean failed step rather than escaping as a framework
            // fault. Not bare Exception: a NullReferenceException here is a bug in this class.
            throw new ArchiveWritingException(ex.Message, ex);
        }
    }

    private static byte[] WriteCore(IReadOnlyList<ArchiveEntry> entries)
    {
        using var buffer = new MemoryStream();

        // THE BRACES ARE LOAD-BEARING, and leaveOpen with them. ZipArchive writes the central
        // directory on Dispose, so ToArray() must run AFTER this block closes -- take the bytes
        // early and the result is a zip with no EOCD, which ZipExtractor correctly rejects as
        // corrupt one hop later, in a branch where the failure carries no file name.
        using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var entry in entries)
            {
                // CreateEntry's default level is Optimal. Stated rather than passed: output size
                // matters because the archive is base64'd into the message body, and there is no
                // option for it -- see the spec's section 4 on why this processor has no knobs.
                var created = zip.CreateEntry(entry.Name);
                created.LastWriteTime = Clamp(entry.ModifiedUtc);

                using var stream = created.Open();
                stream.Write(entry.Content);
            }
        }

        // An EMPTY list falls through the loop and produces the canonical 22-byte EOCD, which is
        // exactly the one archive ZipExtractor.IsCanonicalEmptyArchive still calls healthy. That is
        // why a document with content:null needs no special case anywhere.
        return buffer.ToArray();
    }

    /// <summary>
    /// The timestamp to store, per the rule: <b>write the value the expander would read back</b>.
    /// <para>
    /// A null or out-of-range stamp becomes the DOS bound, because that is precisely what
    /// <c>ZipExtractor</c> reports for such an entry afterwards -- which makes collapse then expand
    /// a fixed point rather than a drift. Null arises from a rar-sourced document (the only
    /// extractor of the three whose timestamp is nullable); a sub-1980 value arises from a
    /// tar-sourced one, where the format can represent what zip cannot.
    /// </para>
    /// <para>
    /// <b>The offset handling is deliberate and was pinned by test, not reasoned about.</b> On .NET
    /// 8.0.31, <c>ZipArchiveEntry.LastWriteTime</c>'s setter validates only <c>value.DateTime.Year</c>
    /// against 1980-2107 and packs <c>value.DateTime</c> -- the WALL-CLOCK component, offset
    /// discarded -- into the DOS fields at write time. <c>ZipExtractor</c>'s getter re-attaches
    /// <b>the offset this machine's local zone has AT THAT WALL-CLOCK VALUE</b> -- not "the offset
    /// right now": in a DST-observing zone a June stamp and a January stamp can legitimately get
    /// different offsets -- and returns <c>.UtcDateTime</c> from that. Neither side ever looks at
    /// the offset the writer supplied.
    /// </para>
    /// <para>
    /// <b>Established by test on this machine (UTC+3, not UTC): a bare
    /// <c>new DateTimeOffset(stamp, TimeSpan.Zero)</c> FAILED the round trip</b> -- it packs the raw
    /// UTC wall clock unchanged, so the getter's later "+3h" re-attachment came back three hours
    /// ahead of the true offset and <c>.UtcDateTime</c> read three hours short of the input
    /// (08:09:10Z round-tripped as 05:09:10Z; the 1980-01-01 floor came back as
    /// 1979-12-31T22:00:00Z). <b>Appending <c>.ToLocalTime()</c> pre-shifts the wall clock by this
    /// same local offset before packing</b>, so the getter's re-attachment exactly cancels the shift
    /// and <c>.UtcDateTime</c> reproduces the input. That fixed the floor and the round-trip test.
    /// </para>
    /// <para>
    /// <b>It then broke the ceiling test</b>: clamping to <c>DosCeiling</c> (2107-12-31T23:59:58Z)
    /// BEFORE the <c>+3h</c> local shift rolled the packed wall clock into 2108-01-01, which fails
    /// the setter's year check and throws -- the exact <see cref="ArgumentOutOfRangeException"/> this
    /// method exists to prevent, on a positive-offset machine specifically. <b>The fix is a second
    /// clamp AFTER the local conversion</b>, on the wall clock that is actually about to be packed
    /// and validated, not only on the UTC instant that was supplied. The pre-conversion clamp is
    /// still needed and still correct -- it is what makes the floor round-trip land on exactly
    /// 1980-01-01T00:00:00Z rather than some offset-shifted neighbour -- the post-conversion clamp is
    /// a second, independent bound that exists purely so a local offset can never push either end
    /// outside the DOS year range. Do not remove either clamp for the other.
    /// </para>
    /// <para>
    /// <b>Only the positive-offset half of this was directly measured; the negative-offset half is
    /// reasoned from the same mechanism, not separately observed on such a machine.</b> At a
    /// negative offset, <c>1980-01-01T00:00:00Z</c> itself is UNREPRESENTABLE: its local wall clock
    /// falls on <c>1979-12-31</c>, which the setter's year check rejects, so the post-conversion
    /// clamp raises the packed wall clock to <c>1980-01-01 00:00:00</c> local -- and the getter then
    /// reads that back as floor + |offset| in UTC, not the floor itself. This is still the right
    /// behaviour: it is the minimum instant that machine can represent at all, it is stable (see the
    /// fixed-point tests below), and it is deliberately not "corrected" back toward the floor -- only
    /// this one non-canonical value round-trips exactly on a negative-offset machine. The fixed point
    /// (collapse of a previously-collapsed value reproduces the same value) holds at every offset,
    /// positive or negative, even on the machines where the floor value itself is not canonical.
    /// </para>
    /// </summary>
    internal static DateTimeOffset Clamp(DateTime? modifiedUtc)
    {
        var instant = modifiedUtc is { } value
            ? DateTime.SpecifyKind(value, DateTimeKind.Utc)
            : DosFloor;

        if (instant < DosFloor)
        {
            instant = DosFloor;
        }
        else if (instant > DosCeiling)
        {
            instant = DosCeiling;
        }

        // .ToLocalTime(), not a bare zero-offset DateTimeOffset -- see the doc comment above for why
        // a zero-offset value fails the round trip on any non-UTC machine.
        var local = new DateTimeOffset(instant, TimeSpan.Zero).ToLocalTime();

        // The second clamp: on the wall clock the local conversion above just produced, because that
        // conversion can itself carry a bound-satisfying UTC instant across a DOS year edge (see the
        // ceiling paragraph above). local.DateTime strips the offset (Kind becomes Unspecified), so
        // this is a plain tick-value comparison against the DosFloor/DosCeiling literals -- exactly
        // the comparison the setter itself performs against value.DateTime.Year.
        var wallClock = local.DateTime;
        if (wallClock < DosFloor)
        {
            wallClock = DosFloor;
        }
        else if (wallClock > DosCeiling)
        {
            wallClock = DosCeiling;
        }

        // DosFloor/DosCeiling carry DateTimeKind.Utc (for readable comparison against instant.Year
        // checks elsewhere); local.DateTime carries Unspecified. A clamp can swap one in for the
        // other, and DateTimeOffset's constructor rejects a Utc-kind DateTime paired with a nonzero
        // offset -- so the Kind is normalized back to Unspecified here regardless of which value won.
        return new DateTimeOffset(DateTime.SpecifyKind(wallClock, DateTimeKind.Unspecified), local.Offset);
    }
}
