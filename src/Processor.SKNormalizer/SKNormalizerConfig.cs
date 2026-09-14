using BaseProcessor.Core.Configuration;

namespace Processor.SKNormalizer;

/// <summary>
/// The step payload this processor binds.
/// <para>
/// <b><see cref="CacheAddress"/> is declared and deliberately unread.</b> It is the seam for the
/// whitelist behaviour: the full L2 address of one projected dictionary —
/// <c>skp:{workflowId}:cache:{root}</c> — which the handler will later append a name to. The
/// operator authors it; nothing rewrites a payload to supply it.
/// </para>
/// <para>
/// It is declared ahead of the behaviour because <c>ProcessorConfig.SerializerOptions</c> leaves
/// <c>UnmappedMemberHandling</c> at Skip: a payload carrying the property against a record that does
/// not declare it binds silently to nothing, which is indistinguishable from a whitelist that
/// matches nothing.
/// </para>
/// <para>
/// <b>When the behaviour ships, a null here is a payload defect, not a cache miss.</b> Reporting it
/// as a miss would cancel every document of a step whose address was simply forgotten, which reads
/// in the logs exactly like a correctly-configured empty whitelist.
/// </para>
/// <para>
/// Authoring it in a payload will also require SKNormalizer's config schema to declare it. Every
/// config schema in the chain sets <c>additionalProperties: false</c>, and schema definitions are
/// frozen — so that is a new schema row, both sides re-pointed, and a restart. Nothing here triggers
/// it; the day an operator writes the property does.
/// </para>
/// </summary>
public sealed record SKNormalizerConfig(string Handler, string? CacheAddress = null) : ProcessorConfig;
