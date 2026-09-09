namespace Processor.FileReader.Extractors;

/// <summary>One entry pulled out of an archive.</summary>
/// <param name="Name">The entry's own file name, without any directory the archive recorded.</param>
/// <param name="ModifiedUtc">Null where the format records none.</param>
public sealed record ExtractedEntry(string Name, byte[] Content, DateTime? ModifiedUtc);

/// <summary>
/// One archive format. Registered in the container and resolved by extension, so adding a format is
/// one class and one registration.
/// </summary>
public interface IArchiveExtractor
{
    /// <summary>True when this extractor handles the extension, compared case-insensitively.</summary>
    bool CanHandle(string extension);

    /// <summary>
    /// Every entry, one level deep. Directories are skipped rather than represented — an empty
    /// directory carries no content and no metadata worth a node.
    /// </summary>
    IReadOnlyList<ExtractedEntry> Extract(Stream archive);
}
