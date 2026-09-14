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
/// <b>Declaring this property is by itself enough to require the config schema to declare it too,
/// and that is not obvious.</b> <c>ConfigSchemaConformance.Check</c> compares the shape of this
/// record against the schema definition — not against any payload — and it runs in two places:
/// <c>SKNormalizerConfigSchemaTests</c>, and <c>ProcessorStartupOrchestrator</c> at startup against
/// the live schema row. So the cost arrives with the property, not with the first operator who
/// authors it. The in-repo fixture is updated alongside this file; the live schema row must be
/// replaced before a build carrying this property is deployed, or the replica fails conformance and
/// publishes UNHEALTHY. Definitions are frozen, so replacing it means POSTing a new row, re-pointing
/// both sides, and restarting.
/// </para>
/// </summary>
public sealed record SKNormalizerConfig(string Handler, string? CacheAddress = null) : ProcessorConfig;
