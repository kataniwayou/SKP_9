namespace Processor.SKNormalizer;

/// <summary>
/// One unit of work a handler found in the incoming tree — typically an audio file and its metadata
/// sidecar, but the grouping is entirely the handler's, because pairing differs per provider.
/// </summary>
/// <param name="Key">
/// The handler's own identifier for this item: a basename, a folder name, an index. It EXISTS FOR
/// FAILURE MESSAGES — a document of forty items whose ninth is malformed is useless to an operator
/// unless the message says which. Derived from upstream content, so it appears in a
/// <c>FailedException</c> message and never in a log template of ours.
/// </param>
/// <param name="Nodes">The leaves the handler grouped into this item.</param>
public sealed record SourceItem(string Key, IReadOnlyList<FileNode> Nodes);

/// <summary>
/// What a handler asks ffmpeg to do. <paramref name="Arguments"/> excludes the input and output
/// paths — the transcoder owns those, because it owns the temp files.
/// </summary>
public sealed record AudioProfile(string TargetExtension, IReadOnlyList<string> Arguments);

/// <summary>
/// What the conversion actually produced. The nullable members are what a probe could not determine;
/// they are folded into the metadata by stage 7 and must not be invented when absent.
/// </summary>
public sealed record NormalizedAudio(
    byte[] Content,
    string Extension,
    long SizeBytes,
    TimeSpan? Duration,
    int? BitrateKbps,
    string? Codec);

/// <summary>The output file names for one item, decided before conversion. See the design's §5.2.</summary>
public sealed record ItemNames(string MetadataFileName, string AudioFileName);

/// <summary>
/// One item, carried through the pipeline and handed to stage 8.
/// <para>
/// <b><see cref="MetadataDocument"/>, <see cref="Audio"/> and <see cref="Names"/> are the input to a
/// HANDLER'S OWN stage 8, not to the base mirror.</b> <c>ProviderHandlerBase.LayoutFor</c>
/// reproduces the input document and substitutes nothing; a handler that emits artifacts overrides
/// <c>LayoutFor</c> and builds its layout out of these three members. That is why they are carried
/// here rather than consumed by shared code.
/// </para>
/// </summary>
/// <param name="MetadataDocument">
/// The rendered metadata, or <b>null when the handler produced none</b>. Rendered by the pipeline
/// after stage 7, so stage 8 receives bytes it can place rather than a model it would have to render
/// itself — a handler never writes angle brackets.
/// <para>
/// <b>Null is how a metadata-only item and a deliberate pass-through are expressed</b>: a handler's
/// own <c>LayoutFor</c> passes the source leaf through rather than replacing it when its item
/// produced no artifact.
/// </para>
/// </param>
/// <param name="Source">The item this one was normalized from.</param>
/// <param name="Metadata">The provider-neutral metadata the handler produced.</param>
/// <param name="Names">The output names this item's artifacts take.</param>
/// <param name="Audio">The converted audio, or null when the item produced none.</param>
public sealed record NormalizedItem(
    SourceItem Source,
    StandardMetadata Metadata,
    ItemNames Names,
    NormalizedAudio? Audio,
    byte[]? MetadataDocument);
