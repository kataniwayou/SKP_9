using BaseProcessor.Core.Configuration;

namespace Processor.SKNormalizer;

/// <summary>
/// The step payload this processor binds.
/// <para>
/// <b><see cref="CacheRoot"/> is the NAME of one projected dictionary, never its address.</b> The full
/// L2 address is <c>skp:{workflowId}:cache:{root}</c>, and the workflow id half is composed at dispatch
/// from <c>BaseProcessor.WorkflowId</c> rather than authored here.
/// </para>
/// <para>
/// <b>That is the whole reason this is a root and not an address.</b> An address carries the workflow's
/// own id, so an operator had to transcribe it into this payload by hand — and nothing on any path kept
/// the copy equal to the id it was copied from. Not the four start gates, none of which inspects a cache
/// address; not <c>PayloadConfigSchemaValidator</c>, which evaluates the payload against the schema and
/// so passes any string at all. The failure that bought was quiet: a recreated workflow left the payload
/// naming a dictionary that would never be projected, and the miss surfaced as a payload defect, which
/// was true and named the wrong half. A root cannot drift that way, because it names nothing the system
/// already knows.
/// </para>
/// <para>
/// <b>What the operator still owns is the alignment between this name and the workflow's bound
/// caches</b> — that this root matches a <c>CacheEntity.Root</c> bound to this workflow through
/// <c>WorkflowCaches</c>. Nothing validates it, at start or before, and that is deliberate rather than
/// an omission: the mistake fails deterministically at the first lookup, in
/// <c>RedisFieldWhitelist.EnsureDictionaryProjected</c>, as a failed step naming both the composed
/// address and this root. A name a reviewer can read against a cache row is a better thing to leave
/// unchecked than a GUID nobody proofreads.
/// </para>
/// <para>
/// It is declared rather than left to bind loosely because <c>ProcessorConfig.SerializerOptions</c>
/// leaves <c>UnmappedMemberHandling</c> at Skip: a payload carrying a property against a record that
/// does not declare it binds silently to nothing, which is indistinguishable from a whitelist that
/// matches nothing. That cuts both ways on a rename — a payload still carrying the old
/// <c>cacheAddress</c> binds nothing here and leaves this null.
/// </para>
/// <para>
/// <b>A null here is a payload defect, not a cache miss — for a handler that gates a field.</b>
/// Reporting it as a miss would cancel every document of a step whose root was simply forgotten, which
/// reads in the logs exactly like a correctly-configured empty whitelist. Handlers that consult no list
/// need no root at all, so the absence is deferred rather than refused: see
/// <c>SKNormalizerProcessor.WhitelistFor</c> and <c>UnconfiguredFieldWhitelist</c>.
/// </para>
/// <para>
/// <b>Declaring this property is by itself enough to require the config schema to declare it too, and
/// that is not obvious.</b> <c>ConfigSchemaConformance.Check</c> compares the shape of this record
/// against the schema definition — not against any payload — and it runs in two places:
/// <c>SKNormalizerConfigSchemaTests</c>, and <c>ProcessorStartupOrchestrator</c> at startup against the
/// live schema row. So RENAMING a property is a schema change, and a definition cannot be edited once
/// referenced: it needs a new row declaring <c>cacheRoot</c>, the processor's <c>configSchemaId</c>
/// re-pointed at it, and a restart. Deploy a build carrying this record against a row that still
/// declares <c>cacheAddress</c> and the replica fails conformance, publishes UNHEALTHY, and
/// <c>ProcessorLivenessValidator</c> then refuses every workflow using it.
/// </para>
/// </summary>
public sealed record SKNormalizerConfig(string Handler, string? CacheRoot = null) : ProcessorConfig;
