namespace Processor.SKNormalizer;

/// <summary>What one dispatch produced. Counts are for the log line; the document is the payload.</summary>
internal sealed record NormalizationResult(FileNode Document, int ItemCount, int ConvertedCount);

/// <summary>
/// The eight stages, in order. <b>The handler decides; this executes.</b> Stages 6 and 8 are the
/// clearest expression of that split — the handler returns a description and shared code carries it
/// out.
/// </summary>
internal sealed class NormalizationPipeline(
    ITreeAssembler assembler, IMetadataRenderer renderer, IAudioTranscoder transcoder)
{
    public NormalizationResult Run(FileNode root, IProviderHandler handler, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(root);
        ArgumentNullException.ThrowIfNull(handler);

        // Stage 1. No item exists yet, so a failure here carries no key — this is the "wrong handler
        // for this feed" failure and the handler's own message is the whole diagnostic.
        var items = handler.Locate(root);

        var normalized = new List<NormalizedItem>(items.Count);
        var converted = 0;

        foreach (var item in items)
        {
            // STOPS AT THE FIRST FAILURE. No partial output and no partial work: continuing would
            // burn a transcode for a document already doomed to be a failed step.
            normalized.Add(Normalize(item, handler, ct, ref converted));
        }

        // Stage 8. The handler describes; the assembler builds and enforces every rule
        // ArchiveCollapser would enforce one hop later.
        var layout = handler.LayoutFor(root, normalized);

        return new NormalizationResult(assembler.Assemble(layout), items.Count, converted);
    }

    private NormalizedItem Normalize(
        SourceItem item, IProviderHandler handler, CancellationToken ct, ref int converted)
    {
        try
        {
            ct.ThrowIfCancellationRequested();

            handler.ValidateContent(item);                      // 2

            var metadata = handler.Map(item);                   // 3
            handler.Augment(metadata, item);                    // 4

            var names = handler.NameFor(metadata, item);        // 5
            var audio = Convert(item, handler, ct);             // 6

            if (audio is not null)
            {
                converted++;
            }

            handler.Reconcile(metadata, audio, names);          // 7

            // Rendered HERE, after stage 7, so stage 8 places bytes rather than rendering them.
            // ARTIFACT EMISSION IS OPTIONAL: empty metadata renders to null, and the mirror carries
            // the leaf through unchanged. A pipeline that always emitted XML could not express
            // identity, a metadata-only item, or a deliberate pass-through.
            var document = metadata.IsEmpty ? null : renderer.Render(metadata);

            return new NormalizedItem(item, metadata, names, audio, document);
        }
        catch (NormalizationException ex)
        {
            // RETHROWN WITH THE KEY PREPENDED, once. The key is upstream-derived, which is why it
            // belongs in this message and in no log template of ours.
            throw new NormalizationException($"item '{item.Key}': {ex.Message}");
        }
    }

    private NormalizedAudio? Convert(SourceItem item, IProviderHandler handler, CancellationToken ct)
    {
        // Null means this item has no audio — a metadata-only item is a legitimate shape. An item
        // that SHOULD have audio and does not is stage 2's business, where it can be reported
        // properly.
        if (handler.ProfileFor(item) is not { } profile)
        {
            return null;
        }

        var source = item.Nodes.FirstOrDefault(n => n.Content is FileContent.Bytes)
            ?? throw new NormalizationException(
                "a conversion profile was named but the item carries no file content");

        var bytes = ((FileContent.Bytes)source.Content!).Value;

        return transcoder.Transcode(bytes, source.Metadata.Extension, profile, ct);
    }
}
