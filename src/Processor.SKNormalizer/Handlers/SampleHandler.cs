namespace Processor.SKNormalizer;

/// <summary>
/// Identity. It locates every entry, produces no metadata and no conversion, and takes the mirror
/// layout — so the document that leaves is the document that arrived.
/// <para>
/// <b>Not a placeholder.</b> It exercises everything structural in one dispatch: payload validation,
/// the config schema enum, registry resolution, the envelope read, all eight stages in order, the
/// assembler's legality rules, serialization through FileNodeConverter, and the send on the inbound
/// executionId. The only things it does not touch are XmlMetadataRenderer and FfmpegAudioTranscoder,
/// which are pure provider business.
/// </para>
/// <para>
/// <b>It stays shipped after real handlers arrive.</b> It is the regression test for the pipeline
/// itself: any change to the stages, the assembler or the serialization that breaks byte identity
/// breaks this first, with nothing provider-specific in the way to obscure it.
/// </para>
/// <para>
/// <b>Stateless, as every handler must be.</b> Registered as a singleton beside a singleton
/// processor; per-dispatch state lives in the pipeline's locals.
/// </para>
/// </summary>
public sealed class SampleHandler : ProviderHandlerBase
{
    /// <summary>
    /// Must match an entry in the <c>handler</c> enum of
    /// <c>src/tests/BaseApi.Tests/Schemas/sknormalizer-config.json</c>.
    /// <c>SKNormalizerConfigSchemaTests</c> is what enforces that.
    /// </summary>
    public override string Name => "Sample";

    public override IReadOnlyList<SourceItem> Locate(FileNode root)
    {
        ArgumentNullException.ThrowIfNull(root);

        // One item per top-level entry, or the root itself when it is a plain file. The key is the
        // node name, which is what a failure message would carry.
        return root.Content is FileContent.Entries entries
            ? entries.Value.Select(e => new SourceItem(e.Metadata.Name, [e])).ToList()
            : [new SourceItem(root.Metadata.Name, [root])];
    }

    // Everything else takes the base default: no content objection, empty metadata, no augmentation,
    // no profile, no reconciliation, and the input-preserving mirror. The mirror substitutes nothing
    // and reproduces the document it was given, so identity falls out by construction rather than by
    // special case — including for a document whose root is a plain file rather than an archive,
    // which Locate already handles above.
}
