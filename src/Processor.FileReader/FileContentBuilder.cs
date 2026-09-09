using Processor.FileReader.Extractors;

namespace Processor.FileReader;

/// <summary>
/// Stage two: everything that involves looking inside the file. Stage one — the processor — is dry
/// and hands this class the bytes it already validated.
/// <para>
/// <b>The structure is hard-coded here. The output schema does not drive it and is not read.</b> The
/// schema judges the result one hop later, in the post handler; it never shapes it.
/// </para>
/// </summary>
internal sealed class FileContentBuilder(IEnumerable<IArchiveExtractor> extractors)
{
    private readonly IReadOnlyList<IArchiveExtractor> _extractors = extractors.ToList();

    /// <summary>
    /// The document. An extension with a registered extractor is expanded one level; anything else
    /// is a leaf.
    /// </summary>
    public FileNode Build(byte[] bytes, FileInfo info, FileReaderConfig config)
    {
        // The EXTENSION decides, not the file's magic bytes. It has already been checked against the
        // payload, so this switch is on a value the workflow author declared — a file whose contents
        // disagree with its name fails in the extractor, which is where that fault belongs.
        var extractor = _extractors.FirstOrDefault(e => e.CanHandle(config.ExpectedExtension));

        if (extractor is null)
        {
            return Leaf(info.Name, bytes, info.CreationTimeUtc, info.LastWriteTimeUtc);
        }

        using var stream = new MemoryStream(bytes, writable: false);
        var entries = extractor.Extract(stream);

        var children = entries
            .Select(e => Leaf(e.Name, e.Content, createdUtc: null, e.ModifiedUtc))
            .ToList();

        return new FileNode(
            new FileMetadata(
                info.Name,
                info.Extension,
                info.Length,
                info.CreationTimeUtc,
                info.LastWriteTimeUtc,
                children.Count),
            // Null, not the archive's bytes: the entries ARE its content, and carrying both doubles
            // the blob.
            Content: null,
            children);
    }

    /// <summary>
    /// A node with content and no entries. Used for a plain file and for every archive entry, which
    /// is what makes depth exactly one — an entry is never itself expanded.
    /// </summary>
    private static FileNode Leaf(string name, byte[] content, DateTime? createdUtc, DateTime? modifiedUtc)
        => new(
            new FileMetadata(
                name,
                Path.GetExtension(name),
                content.LongLength,
                createdUtc,
                modifiedUtc,
                EntryCount: 0),
            content,
            []);
}
