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

        var children = new List<FileNode>(entries.Count);

        // THE EXPANSION CEILING. Without it the only bound anywhere is on the FILE, and an archive is
        // exactly where that stops being the transient cost: §6 and k8s/37-processor-filereader.yaml
        // both price the pod at ~1.78x the file, which is right for a leaf and wrong for an archive,
        // where the document is ~1.33x the EXPANDED content. An ordinary 10:1 CSV zip at a 32 MiB
        // ceiling is ~320 MB expanded plus document and envelope, against a 768Mi limit.
        //
        // An OOM here is not one lost message, it is a POISON MESSAGE. The author never returns, so
        // ProcessDispatchHandler never reclaims the input key; RabbitMQ requeues the unacked dispatch;
        // the replacement pod reads the same key and dies the same way. One archive takes the
        // processor down for every workflow on that queue. A FailedException is acked and terminal,
        // which is the entire difference.
        var expandedBytes = 0L;

        foreach (var entry in entries)
        {
            expandedBytes += entry.Content.LongLength;

            // Checked as the entries accumulate rather than over a finished total, so the nodes for
            // the remaining entries are never built. NOTE the honest limit of that: the extractor
            // above has already materialised every entry's bytes by the time this loop runs — the
            // seam returns a list, and it cannot stream, because wrapping a library fault requires a
            // try/catch and C# forbids `yield return` inside one. So this bounds the document and
            // gives a deterministic, acked failure; it does not bound the extractor's own peak. That
            // residual is recorded rather than papered over.
            if (expandedBytes > config.MaximumSizeBytes)
            {
                // ArchiveExtractionException so it lands on the contract's
                // `extracting {FilePath} failed:` template — the processor's one catch. Both numbers
                // are named, because an operator needs to see which limit was hit and by how much;
                // "at least" is literal, since the loop stops before totalling what is left.
                throw new ArchiveExtractionException(
                    $"the archive expands to at least {expandedBytes} bytes, above the "
                    + $"{config.MaximumSizeBytes} byte ceiling that bounds the expansion as well as "
                    + "the file");
            }

            children.Add(Leaf(entry.Name, entry.Content, createdUtc: null, entry.ModifiedUtc));
        }

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
