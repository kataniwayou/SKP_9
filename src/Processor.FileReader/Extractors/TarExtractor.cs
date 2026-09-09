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
        // TarReader throws rather than returning null-with-no-entries on malformed input —
        // EndOfStreamException on truncated bytes, InvalidDataException on bytes that parse far
        // enough to fail a field — verified directly against this in-box reader before writing this
        // method. So there is no false-HEALTHY case here to guard against: a genuinely empty tar (the
        // two zero terminator blocks) and a corrupt one are already distinguishable by TarReader
        // itself, the former returning no entries and the latter throwing.
        using var reader = new TarReader(archive, leaveOpen: true);

        var entries = new List<ExtractedEntry>();

        while (reader.GetNextEntry() is { } entry)
        {
            // Regular files only. Directories, links and device nodes carry no content this document
            // has a place for, and representing them would make entryCount disagree with the nodes a
            // reader sees.
            if (entry.EntryType is not (TarEntryType.RegularFile or TarEntryType.V7RegularFile)
                || entry.DataStream is null)
            {
                continue;
            }

            using var buffer = new MemoryStream();
            entry.DataStream.CopyTo(buffer);

            entries.Add(new ExtractedEntry(
                // The archive records a path; the node carries a name. A separator in a node name
                // would read as structure the document does not have.
                Path.GetFileName(entry.Name),
                buffer.ToArray(),
                // .UtcDateTime, not .DateTime or .LocalDateTime: ModificationTime is a
                // DateTimeOffset, and only the UtcDateTime conversion yields DateTimeKind.Utc. A
                // Local or Unspecified DateTime renders through System.Text.Json without the
                // trailing Z (or with an offset instead), which fails the output schema one hop
                // after this method returns — a branch where the failure is discarded rather than
                // reported.
                entry.ModificationTime.UtcDateTime));
        }

        return entries;
    }
}
