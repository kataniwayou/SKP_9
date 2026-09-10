using BaseProcessor.Core.Configuration;

namespace Processor.ArchiveCollapser;

/// <summary>
/// The step payload, and it holds NOTHING. This is a marker, and it exists only because the type
/// system demands one: <c>BaseProcessor.ExecuteAsync</c> is <c>internal abstract</c>, so nothing
/// outside <c>BaseProcessor.Core</c> can derive from the non-generic base, and
/// <c>BaseProcessor{TConfig}</c> is the only door.
/// <para>
/// <b>There is deliberately no MaxDepth.</b> On ArchiveExpander that field is a genuine choice --
/// how far to go. Here there is nothing to choose: the depth is a property of the document that
/// arrived, and the document is the source of truth. A payload field could only ever contradict it.
/// </para>
/// <para>
/// <b>Do not add a null check for this in the processor.</b> ArchiveExpander rejects a null payload;
/// this one must not. Null is legal, <c>{}</c> is legal, and a payload left over from another step
/// is legal, because nothing reads it. An empty payload never even deserializes --
/// <c>BaseProcessor{TConfig}.ExecuteAsync</c> short-circuits on whitespace and passes null.
/// </para>
/// <para>
/// No config schema is registered for this processor, so
/// <c>PayloadConfigSchemaValidator</c> skips it at publish. That is the house norm, not an
/// exception: no processor in this repo ships a config schema.
/// </para>
/// </summary>
public sealed record ArchiveCollapserConfig : ProcessorConfig;
