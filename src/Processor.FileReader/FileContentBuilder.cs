using Processor.FileReader.Extractors;

namespace Processor.FileReader;

/// <summary>
/// The document, and how deep the expansion actually went.
/// <para>
/// <b>The depth is returned rather than logged here because it is the only place it survives.</b> A
/// document that fails its output schema is reported by the framework with
/// <c>EntryId: Guid.Empty</c>, no payload and no file path — so if a step's <c>MaxDepth</c> and the
/// registered schema disagree, nothing in the failure says which depth was produced. The processor
/// logs this alongside the entry count, where an operator can find it.
/// </para>
/// </summary>
internal sealed record FileBuildResult(FileNode Node, int DepthReached);

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
    /// The document. An archive is expanded until <see cref="FileReaderConfig.MaxDepth"/> is
    /// reached or nothing left is an archive, whichever comes first.
    /// </summary>
    public FileBuildResult Build(byte[] bytes, FileInfo info, FileReaderConfig config)
    {
        // THE DECLARATION CROSS-CHECK, and it applies to the top-level file ONLY.
        //
        // Choosing the extractor by signature means a file whose bytes are not an archive is simply
        // a leaf — which is right for a CSV and WRONG for a damaged zip, because the step would
        // report Completed over a file nobody can open. That is the false-HEALTHY failure each
        // extractor's internal guard exists to prevent, reached from outside those guards: a
        // corrupt header matches no signature, so no extractor is ever asked.
        //
        // Here, and only here, there is something to check the bytes against. ExpectedExtension had
        // to match this file's extension for it to be admitted at all, so a name declaring an
        // archive is a claim a workflow author made. Below this level nothing is declared — an
        // entry's name is written by whoever built the archive — so nested entries get no such
        // check and an unrecognised one is an ordinary leaf.
        //
        // A .zip that is really a tar does NOT fail: an extractor claims it by signature, and
        // reading the content is the more useful answer than refusing the name.
        if (NamedAsArchive(info.Extension) && Match(bytes) is null)
        {
            throw new ArchiveExtractionException(
                $"the file is named '{info.Extension}' and its leading bytes are no archive this "
                + "processor knows — treating it as corrupt rather than recording it as a plain file");
        }

        // ONE budget for the WHOLE tree, not one per level. Threading a running total through the
        // recursion is what keeps MaxDepth safe to raise: a per-level ceiling would let a depth-5
        // archive hold five times the limit, and the pod's memory does not care which level a byte
        // came from.
        var budget = new ExpansionBudget(config.MaximumSizeBytes);
        var depthReached = 0;

        var node = BuildNode(
            info.Name,
            info.Extension,
            bytes,
            // FileInfo.Length rather than the array's length: for the root they agree, and the
            // former is what the dry inspection already reported to an operator.
            info.Length,
            info.CreationTimeUtc,
            info.LastWriteTimeUtc,
            depth: 0,
            config.MaxDepth,
            budget,
            ref depthReached);

        return new FileBuildResult(node, depthReached);
    }

    /// <summary>
    /// One node, and its subtree.
    /// <para>
    /// <b>Plain recursion, and the bound is the reason it is safe.</b> <c>MaxDepth</c> is validated
    /// into <c>1..FileReaderConfig.MaxSupportedDepth</c> before any file is opened, so the stack
    /// here is at most that many frames deep. There is no unlimited setting for this to run away on.
    /// </para>
    /// </summary>
    private FileNode BuildNode(
        string name,
        string extension,
        byte[] bytes,
        long sizeBytes,
        DateTime? createdUtc,
        DateTime? modifiedUtc,
        int depth,
        int maxDepth,
        ExpansionBudget budget,
        ref int depthReached)
    {
        if (depth > depthReached)
        {
            depthReached = depth;
        }

        // THE BYTES DECIDE, not the name. See IArchiveExtractor.CanHandle for why this reversed:
        // below the first level there is no declared extension to trust, because an entry's name is
        // written by whoever built the archive. FileReaderConfig.ExpectedExtension still admits the
        // file to the step; it no longer chooses what opens it.
        //
        // No match is the ordinary termination: a CSV matches nothing and is a leaf.
        var extractor = depth < maxDepth ? Match(bytes) : null;

        if (extractor is null)
        {
            // A leaf, and that includes an archive the depth limit stopped us opening — an
            // unexpanded archive is a file, so it carries its own bytes exactly like any other.
            return new FileNode(
                new FileMetadata(name, extension, sizeBytes, createdUtc, modifiedUtc, EntryCount: 0),
                new FileContent.Bytes(bytes));
        }

        using var stream = new MemoryStream(bytes, writable: false);
        var entries = extractor.Extract(stream);

        var children = new List<FileNode>(entries.Count);

        foreach (var entry in entries)
        {
            // Charged BEFORE the child is built, so the budget stops the walk at the entry that
            // crosses it rather than after its whole subtree is materialised. A nested archive is
            // charged twice on purpose — once as its parent's entry, once for what it expands to —
            // because at that moment both genuinely exist in memory.
            budget.Charge(entry.Content.LongLength);

            children.Add(BuildNode(
                entry.Name,
                Path.GetExtension(entry.Name),
                entry.Content,
                entry.Content.LongLength,
                // Archives record no creation time; only a modification time, and not in every
                // format.
                createdUtc: null,
                entry.ModifiedUtc,
                depth + 1,
                maxDepth,
                budget,
                ref depthReached));
        }

        return new FileNode(
            new FileMetadata(name, extension, sizeBytes, createdUtc, modifiedUtc, children.Count),
            // Null, not an empty list: an archive that expanded to nothing has no entries, and the
            // document says so with one value rather than an empty array a reader has to interpret.
            children.Count == 0 ? null : new FileContent.Entries(children));
    }

    /// <summary>
    /// True when some registered extractor is normally named with this extension — i.e. the name
    /// claims to be an archive this processor can open.
    /// </summary>
    private bool NamedAsArchive(string extension)
        => _extractors.Any(e => e.Extension.Equals(extension, StringComparison.OrdinalIgnoreCase));

    /// <summary>The first extractor that recognises these bytes, or null when none does.</summary>
    private IArchiveExtractor? Match(ReadOnlySpan<byte> bytes)
    {
        // A plain loop rather than LINQ: a ReadOnlySpan cannot be captured by a lambda, and copying
        // the array to satisfy FirstOrDefault would allocate a second copy of every file.
        foreach (var extractor in _extractors)
        {
            if (extractor.CanHandle(bytes))
            {
                return extractor;
            }
        }

        return null;
    }

    /// <summary>
    /// THE EXPANSION CEILING, carried across the whole tree.
    /// <para>
    /// Without it the only bound anywhere is on the FILE, and an archive is exactly where that stops
    /// being the transient cost: the design and <c>k8s/37-processor-filereader.yaml</c> both price
    /// the pod at ~1.78x the file, which is right for a leaf and wrong for an archive, where the
    /// document is ~1.33x the EXPANDED content. An ordinary 10:1 CSV zip at a 32 MiB ceiling is
    /// ~320 MB expanded plus document and envelope, against a 768Mi limit.
    /// </para>
    /// <para>
    /// <b>An OOM here is not one lost message, it is a POISON MESSAGE.</b> The author never returns,
    /// so <c>ProcessDispatchHandler</c> never reclaims the input key; RabbitMQ requeues the unacked
    /// dispatch; the replacement pod reads the same key and dies the same way. One archive takes the
    /// processor down for every workflow on that queue. A <c>FailedException</c> is acked and
    /// terminal, which is the entire difference.
    /// </para>
    /// <para>
    /// <b>The honest limit of this, unchanged by depth:</b> an extractor has already materialised
    /// every entry's bytes by the time the loop above runs — the seam returns a list, and it cannot
    /// stream, because wrapping a library fault requires a try/catch and C# forbids
    /// <c>yield return</c> inside one. So this bounds the DOCUMENT and gives a deterministic, acked
    /// failure; it does not bound any single extractor's own peak. That residual is recorded rather
    /// than papered over.
    /// </para>
    /// </summary>
    private sealed class ExpansionBudget(long ceiling)
    {
        private long _spent;

        public void Charge(long bytes)
        {
            _spent += bytes;

            if (_spent <= ceiling)
            {
                return;
            }

            // ArchiveExtractionException so it lands on the contract's `extracting {FilePath}
            // failed:` template — the processor's one catch. Both numbers are named, because an
            // operator needs to see which limit was hit and by how much; "at least" is literal,
            // since the walk stops before totalling what is left.
            throw new ArchiveExtractionException(
                $"the archive expands to at least {_spent} bytes, above the {ceiling} byte ceiling "
                + "that bounds the expansion as well as the file");
        }
    }
}
