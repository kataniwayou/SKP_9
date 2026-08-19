using Messaging.Contracts;

namespace BaseProcessor.Core.Identity;

/// <summary>
/// D-06: the mutable singleton holder shared between the startup orchestrator (writer of identity +
/// definitions + the Healthy flip) and every reader — the liveness heartbeat, the readiness check,
/// the log enricher and the metric increment sites. Populated in two startup loops:
/// <list type="number">
///   <item>Loop A resolves identity by SourceHash → <see cref="SetIdentity"/> (Id + 3 schema Ids).</item>
///   <item>Loop B resolves each non-null input/output/config definition → <see cref="SetDefinition"/>.</item>
/// </list>
/// then <see cref="MarkHealthy"/> flips the latch.
///
/// <para>
/// <b>Everything a reader needs is one immutable snapshot behind one synchronized read (WR-03).</b>
/// <see cref="Identity"/> is either null — Loop A has not resolved yet — or a fully populated
/// <see cref="ProcessorIdentity"/> in which <c>Id</c>, <c>Name</c> and <c>Version</c> are all
/// non-nullable. There is no state in which one of them is visible and another is not, so a reader
/// never has to guard them independently of each other, and there is no torn read to document.
/// </para>
/// <para>
/// This replaces an earlier shape that exposed the nine fields as separate plain auto-properties with
/// no barrier, safe to read from another thread only after observing <see cref="IsHealthy"/>. That
/// rule could not be enforced, only restated: the properties are read from MassTransit consumer
/// threads that reach them through a queue bound *before* <see cref="MarkHealthy"/> is called, so
/// "read it after Healthy" was not something a call site could honour even when it tried.
/// </para>
/// </summary>
public interface IProcessorContext
{
    /// <summary>
    /// The resolved identity and whatever definitions Loop B has filled in so far, or null until
    /// Loop A completes. Safe to read from any thread: the whole snapshot is published at once, and
    /// a reader that captured it keeps a consistent view even as later definitions arrive.
    /// </summary>
    ProcessorIdentity? Identity { get; }

    /// <summary>
    /// True once identity + all required (non-null) definitions are resolved AND Gate A has passed
    /// (LIVE-04 meaning of "Healthy"). Distinct from <see cref="Identity"/> being non-null: a Gate-A
    /// clash leaves a fully resolved identity permanently unhealthy. Cheap volatile read for the
    /// per-beat heartbeat gate.
    /// </summary>
    bool IsHealthy { get; }

    /// <summary>Publishes the resolved Id, the three schema Ids, and the Name/Version pair.</summary>
    void SetIdentity(ProcessorIdentityFound identity);

    /// <summary>
    /// Publishes a resolved definition into every slot whose schema id matches
    /// <paramref name="schemaId"/> — input, output, config (D-12/D-14: the config definition is
    /// Gate A's input). Matching is by independent tests, not else-if, so one fetch fills both slots
    /// when two roles share an id. A schema id matching no slot is ignored.
    /// <para>
    /// Throws if called before <see cref="SetIdentity"/>: Loop B runs only after Loop A resolves, so
    /// an out-of-order call is a sequencing bug. Swallowing it would leave the config definition null,
    /// which Gate A reads as "no config schema, skip" — and the processor would reach Healthy without
    /// ever validating its config.
    /// </para>
    /// </summary>
    void SetDefinition(Guid schemaId, string definition);

    /// <summary>Flips the Healthy latch (idempotent).</summary>
    void MarkHealthy();
}
