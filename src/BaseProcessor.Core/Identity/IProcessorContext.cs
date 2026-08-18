using Messaging.Contracts;

namespace BaseProcessor.Core.Identity;

/// <summary>
/// D-06: the mutable singleton holder shared between the startup orchestrator (writer of identity +
/// definitions + the Healthy flip) and the liveness heartbeat (reader of identity + definitions +
/// the Healthy gate). Populated in two startup loops:
/// <list type="number">
///   <item>Loop A resolves identity by SourceHash → <see cref="SetIdentity"/> (Id + 3 schema Ids).</item>
///   <item>Loop B resolves each non-null input/output/config definition → <see cref="SetDefinition"/>.</item>
/// </list>
/// then <see cref="MarkHealthy"/> flips the latch.
///
/// <para>
/// <b>Memory-visibility invariant (WR-03):</b> only <see cref="IsHealthy"/> carries synchronization.
/// The identity and definition properties (<see cref="Id"/>,
/// <see cref="InputSchemaId"/>, <see cref="OutputSchemaId"/>, <see cref="ConfigSchemaId"/>,
/// <see cref="InputDefinition"/>, <see cref="OutputDefinition"/>, <see cref="ConfigDefinition"/>,
/// <see cref="Name"/>, <see cref="Version"/>) are plain auto-properties with NO
/// volatile/barrier semantics. They are only safe to read from another thread AFTER observing
/// <see cref="IsHealthy"/> == <c>true</c> — the
/// full barrier in <see cref="MarkHealthy"/>'s <c>Interlocked.Exchange</c> publishes the prior
/// identity/definition writes. Reading these properties from another thread WITHOUT first observing
/// Healthy may return stale nulls.
/// </para>
/// </summary>
public interface IProcessorContext
{
    /// <summary>The resolved processor Id (null until Loop A completes).</summary>
    Guid? Id { get; }

    /// <summary>The input schema Id (null for a source processor).</summary>
    Guid? InputSchemaId { get; }

    /// <summary>The output schema Id (null for a sink processor).</summary>
    Guid? OutputSchemaId { get; }

    /// <summary>The config schema Id (resolved to a definition by Loop B for Gate A — D-12).</summary>
    Guid? ConfigSchemaId { get; }

    /// <summary>The resolved processor Name (DB single source of truth; null until Loop A completes). WR-03: read after IsHealthy.</summary>
    string? Name { get; }

    /// <summary>The resolved processor Version (DB single source of truth; null until Loop A completes). WR-03: read after IsHealthy.</summary>
    string? Version { get; }

    /// <summary>The resolved input schema definition (null until Loop B resolves it).</summary>
    string? InputDefinition { get; }

    /// <summary>The resolved output schema definition (null until Loop B resolves it).</summary>
    string? OutputDefinition { get; }

    /// <summary>The resolved config schema definition (null until Loop B resolves it — D-14). WR-03: read after IsHealthy.</summary>
    string? ConfigDefinition { get; }

    /// <summary>
    /// True once identity + all required (non-null) definitions are resolved (LIVE-04 meaning of
    /// "Healthy"). Cheap volatile read for the per-beat heartbeat gate.
    /// </summary>
    bool IsHealthy { get; }

    /// <summary>Stores the resolved Id + the three schema Ids from the identity response.</summary>
    void SetIdentity(ProcessorIdentityFound identity);

    /// <summary>
    /// Stores the resolved definition into <see cref="InputDefinition"/> when
    /// <paramref name="schemaId"/> matches <see cref="InputSchemaId"/>,
    /// <see cref="OutputDefinition"/> when it matches <see cref="OutputSchemaId"/>, or
    /// <see cref="ConfigDefinition"/> when it matches <see cref="ConfigSchemaId"/> (D-12 — Gate A's input).
    /// </summary>
    void SetDefinition(Guid schemaId, string definition);

    /// <summary>Flips the Healthy latch (idempotent).</summary>
    void MarkHealthy();
}
