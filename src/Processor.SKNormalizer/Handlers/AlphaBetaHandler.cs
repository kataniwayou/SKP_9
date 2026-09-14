namespace Processor.SKNormalizer;

/// <summary>
/// Lifts the standardized XML out of a document and makes it the WHOLE document: one leaf, no
/// archive, no entries, nothing else carried.
/// <para>
/// <b>It runs AFTER <see cref="AcmeHandler"/>, on that handler's output, and it renders nothing of
/// its own.</b> Acme has already mapped the sidecar, transcoded the audio and written the measured
/// codec and bitrate into an <c>.xml</c> entry; this handler finds that entry and passes its bytes
/// through untouched. So the file that lands in the output folder is <b>byte-identical</b> to the
/// copy inside the archive the Acme branch writes — not "kept in step with" it, but literally the
/// same bytes, which is the only way two producers of one document never disagree.
/// </para>
/// <para>
/// <b>Why after rather than beside.</b> Wired as a second successor of the Acme step with
/// <c>PreviousCompleted</c>, this work is skipped entirely when Acme fails — there is no XML to lift
/// and no point transcoding anything twice. A parallel branch off ArchiveExpander would do the whole
/// provider mapping a second time and would still run after its sibling had already failed.
/// </para>
/// <para>
/// <b>Every stage except 1, 2 and 8 is the base default, and that is load-bearing.</b>
/// <c>Map</c> returns an empty <see cref="StandardMetadata"/> and nothing populates it, so
/// <c>IsUnset</c> stays true, the pipeline renders NO document and hands <c>MetadataDocument</c>
/// null — which is exactly how a pass-through is expressed. <b>Overriding <c>Reconcile</c> to fold
/// in an audio file name would break that</b>: the metadata would stop being unset, the pipeline
/// would demand every required element, and every dispatch would fail on an incomplete document.
/// </para>
/// <para>
/// <b>A LEAF ROOT IS THE POINT, not a degenerate case.</b> <c>OutputLayout</c>'s root is an
/// <c>OutputNode</c> rather than a name plus a child list precisely so this shape is expressible;
/// <c>TreeAssembler</c> builds a leaf root through the same code as any other node, and
/// <c>ArchiveCollapser</c>'s <c>ArchiveBuilder</c> reads a <c>Bytes</c> root as an already-built
/// file and carries it through without packing. So <c>file-persister</c> is handed an <c>.xml</c>
/// and writes one — no zip is ever created on this branch.
/// </para>
/// <para>
/// <b>Stateless, as every handler must be.</b> Registered as a singleton beside a singleton
/// processor; per-dispatch state lives in the pipeline's locals. It takes no
/// <see cref="TimeProvider"/> because it stamps nothing — it writes no metadata of its own.
/// </para>
/// </summary>
public sealed class AlphaBetaHandler : ProviderHandlerBase
{
    /// <summary>What a standardized metadata entry is named, which is what this handler lifts.</summary>
    private const string MetadataExtension = ".xml";

    /// <summary>
    /// Must match an entry in the <c>handler</c> enum of
    /// <c>src/tests/BaseApi.Tests/Schemas/sknormalizer-config.json</c>.
    /// <c>SKNormalizerConfigSchemaTests</c> is what enforces that.
    /// </summary>
    public override string Name => "AlphaBeta";

    /// <summary>
    /// Stage 1. One item per <c>.xml</c> entry at the document's ROOT, keyed by its basename.
    /// <para>
    /// <b>Everything that is not an <c>.xml</c> is left out of the item list, not rejected.</b> This
    /// handler's whole purpose is to discard the rest — the audio Acme just produced belongs to the
    /// other branch's archive — so an <c>.mp3</c> beside the XML is expected, not a fault. That is
    /// the opposite of <c>AcmeHandler.ValidateContent</c>, which refuses a third entry because
    /// carrying one would silently drop it; here dropping is the contract.
    /// </para>
    /// <para>
    /// <b>A LEAF ROOT IS A FAILED STEP, NOT AN EMPTY RESULT.</b> Returning no items for one would
    /// send an empty list into <see cref="LayoutFor"/>, and a handler that then built a childless
    /// container would have the assembler emit <c>content: null</c> — the document's bytes destroyed
    /// with no failed step. <see cref="LayoutFor"/> refuses the empty list too, so this is belt and
    /// braces; the message here is the better one, because it names the shape rather than the count.
    /// </para>
    /// <para>
    /// <b>Root entries only, deliberately.</b> Acme emits a flat document — one container holding the
    /// audio and the XML — so an XML nested deeper came from something other than the step this
    /// handler is wired behind, and lifting it would quietly accept a feed nobody designed for.
    /// </para>
    /// </summary>
    /// <exception cref="NormalizationException">The root is a file rather than a document.</exception>
    public override IReadOnlyList<SourceItem> Locate(FileNode root)
    {
        ArgumentNullException.ThrowIfNull(root);

        if (root.Content is FileContent.Bytes)
        {
            throw new NormalizationException(
                $"'{root.Metadata.Name}' is a file rather than a document holding entries, and "
                + $"{Name} lifts the standardized {MetadataExtension} out of one — wire it after a "
                + "step that produces one");
        }

        if (root.Content is not FileContent.Entries entries)
        {
            // A document that expanded to nothing. No items; LayoutFor turns that into the failure,
            // where the count and the root's name are both in hand.
            return [];
        }

        return entries.Value
            .Where(e => string.Equals(
                e.Metadata.Extension, MetadataExtension, StringComparison.OrdinalIgnoreCase))
            .Select(e => new SourceItem(Path.GetFileNameWithoutExtension(e.Metadata.Name), [e]))
            .ToList();
    }

    /// <summary>
    /// Stage 2. The entry must carry bytes.
    /// <para>
    /// <b>Checked here rather than at stage 8 so the failure names the item.</b>
    /// <c>NormalizationPipeline</c> prepends <c>item '{key}': </c> to anything thrown from a per-item
    /// stage; stage 8 runs outside that loop. <c>FileNode.Content</c> is nullable and an expander can
    /// emit a node with none, so "an entry named .xml that holds nothing" is a real shape and not a
    /// theoretical one.
    /// </para>
    /// </summary>
    public override void ValidateContent(SourceItem item)
    {
        ArgumentNullException.ThrowIfNull(item);

        if (item.Nodes[0].Content is not FileContent.Bytes)
        {
            throw new NormalizationException(
                $"the {MetadataExtension} entry carries no content, so there is nothing to lift");
        }
    }

    /// <summary>
    /// Stage 8. The XML entry, promoted to the whole document.
    /// <para>
    /// <b>The bytes are the SOURCE node's, unmodified.</b> <c>MetadataDocument</c> is null on every
    /// item here — nothing was rendered, because nothing needed to be — so this is a pass-through in
    /// the strict sense: whatever Acme wrote is what leaves, and the two copies of the document
    /// cannot drift because there is only ever one.
    /// </para>
    /// <para>
    /// <b>The name and both timestamps travel with it.</b> The root becomes <c>track01.xml</c>, which
    /// <c>ArchiveCollapser</c> puts straight onto the envelope, so <c>file-persister</c> writes
    /// <c>track01.xml</c>. The input container's name — <c>acme-….zip</c> — is deliberately dropped:
    /// the document is no longer that archive.
    /// </para>
    /// <para>
    /// <b>Exactly one, or a failed step.</b> A leaf root holds one file, so a document carrying two
    /// standardized XMLs has no representation here. Emitting the first and dropping the rest would
    /// destroy the others with nothing failing, and wrapping them in a container would be the archive
    /// this handler exists not to produce. <b>This is the one document the two branches disagree
    /// about</b>: a multi-pair bundle completes on the Acme branch, which has somewhere to put both.
    /// </para>
    /// </summary>
    public override OutputLayout LayoutFor(FileNode root, IReadOnlyList<NormalizedItem> items)
    {
        ArgumentNullException.ThrowIfNull(root);
        ArgumentNullException.ThrowIfNull(items);

        // NAMED, NOT COUNTED. An operator looking at this failure needs to know which XMLs were
        // found, and the keys are the basenames they will look for in the upstream archive.
        if (items.Count != 1)
        {
            throw new NormalizationException(
                $"an {Name} document is one standardized {MetadataExtension} and nothing else, so "
                + $"'{root.Metadata.Name}' must hold exactly one — it holds {items.Count}"
                + (items.Count == 0
                    ? string.Empty
                    : $": {string.Join(", ", items.Select(i => $"'{i.Source.Key}{MetadataExtension}'"))}"));
        }

        var node = items[0].Source.Nodes[0];

        // ValidateContent already refused a contentless node; this throw is what lets the cast above
        // it be unconditional rather than a null-forgiving operator on upstream data.
        if (node.Content is not FileContent.Bytes bytes)
        {
            throw new NormalizationException(
                $"item '{items[0].Source.Key}': the {MetadataExtension} entry carries no content");
        }

        return new OutputLayout(new OutputNode.File(
            node.Metadata.Name, bytes.Value, node.Metadata.CreatedUtc, node.Metadata.ModifiedUtc));
    }
}
