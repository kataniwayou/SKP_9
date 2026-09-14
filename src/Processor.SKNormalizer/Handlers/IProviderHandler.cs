namespace Processor.SKNormalizer;

/// <summary>
/// One provider's business, as a set of tools the pipeline calls in a fixed order.
/// <para>
/// <b>EVERY MEMBER IS ABOUT CONTENT. None validates a schema and none needs to.</b> Schema
/// validation happens at exactly two points, both in the framework and neither reachable from here:
/// <c>ProcessDispatchHandler</c> validates the input before this processor is entered, and
/// <c>ProcessedDataHandler</c> validates the output after the send. A handler is handed data already
/// proven to fit its contract, and its result is proven again on the way out.
/// </para>
/// <para>
/// <b><see cref="LayoutFor"/> is the only member whose RESULT is schema-relevant</b>, since a layout
/// that nested too deep would fail output validation — which is exactly why <c>TreeAssembler</c>
/// owns legality and why the default layout preserves the input topology.
/// </para>
/// <para>
/// <b>Implementations MUST be stateless.</b> They are registered as singletons, and so is the
/// processor itself — per-dispatch state lives in the pipeline's locals. A handler holding per-item
/// fields would break silently.
/// </para>
/// </summary>
public interface IProviderHandler
{
    /// <summary>
    /// The registry key, matched case-insensitively against the <c>handler</c> field on the step
    /// payload. An author constant, never upstream content, so it is safe to log.
    /// </summary>
    string Name { get; }

    /// <summary>Stage 1. Finds the units of work in the incoming tree.</summary>
    IReadOnlyList<SourceItem> Locate(FileNode root);

    /// <summary>
    /// Stage 2. Rejects content this provider got wrong — a missing required field, an audio stream
    /// that is not what the metadata claims. <b>Not schema validation</b>; see the type remarks.
    /// </summary>
    /// <exception cref="NormalizationException">The content is not usable.</exception>
    void ValidateContent(SourceItem item);

    /// <summary>Stage 3. Projects the provider's fields into the standard metadata.</summary>
    StandardMetadata Map(SourceItem item);

    /// <summary>Stage 4. Adds fields knowable BEFORE conversion.</summary>
    void Augment(StandardMetadata metadata, SourceItem item, IFieldWhitelist whitelist);

    /// <summary>
    /// Stage 5. Decides output names. Runs before conversion because the transcoder needs a target
    /// name and the XML must reference the audio it describes — so a convention may use the
    /// REQUESTED profile and may not use measured output.
    /// </summary>
    ItemNames NameFor(StandardMetadata metadata, SourceItem item);

    /// <summary>
    /// Stage 6, the decision half. <b>Null means this item has no audio</b> — a metadata-only item
    /// is a legitimate shape, not a failure, and the pipeline skips the transcode. An item that
    /// SHOULD have audio and does not is stage 2's business.
    /// </summary>
    AudioProfile? ProfileFor(SourceItem item);

    /// <summary>
    /// Stage 7. Folds what the conversion actually produced back into the metadata. Duration, real
    /// bitrate, the codec ffmpeg chose and the output size are knowable nowhere else.
    /// </summary>
    void Reconcile(StandardMetadata metadata, NormalizedAudio? audio, ItemNames names);

    /// <summary>
    /// Stage 8, the decision half. Describes the output tree; the assembler builds it.
    /// <paramref name="root"/> is the INPUT document, so the default can mirror its topology.
    /// </summary>
    OutputLayout LayoutFor(FileNode root, IReadOnlyList<NormalizedItem> items);
}
