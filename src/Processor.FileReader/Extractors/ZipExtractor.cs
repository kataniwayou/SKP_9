using System.IO.Compression;

namespace Processor.FileReader.Extractors;

/// <summary>
/// Zip, on the in-box <c>System.IO.Compression</c>. No package.
/// </summary>
public sealed class ZipExtractor : IArchiveExtractor
{
    public bool CanHandle(string extension)
        => ".zip".Equals(extension, StringComparison.OrdinalIgnoreCase);

    public IReadOnlyList<ExtractedEntry> Extract(Stream archive)
    {
        using var zip = new ZipArchive(archive, ZipArchiveMode.Read);

        var entries = new List<ExtractedEntry>(zip.Entries.Count);

        foreach (var entry in zip.Entries)
        {
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
            // .UtcDateTime, not .DateTime or .LocalDateTime: LastWriteTime is a DateTimeOffset, and
            // only the UtcDateTime conversion yields DateTimeKind.Utc. System.Text.Json renders a
            // Local or Unspecified DateTime without the trailing Z (or with an offset instead),
            // which fails the output schema one hop after this method returns — a branch where the
            // failure is discarded rather than reported.
            entries.Add(new ExtractedEntry(
                entry.Name, buffer.ToArray(), entry.LastWriteTime.UtcDateTime));
        }

        return entries;
    }
}
