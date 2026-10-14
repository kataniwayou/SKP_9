using System.Text.Json;

namespace Messaging.Contracts.Projections;

/// <summary>What one replica's per-instance liveness value says about that replica.</summary>
public enum ReplicaLiveness
{
    /// <summary>The instance index names it, but its per-instance key is gone (expired or never written).</summary>
    Absent,

    /// <summary>The value is there but will not read as a <see cref="ProcessorLivenessEntry"/>.</summary>
    Malformed,

    /// <summary>The replica reported itself unhealthy.</summary>
    Unhealthy,

    /// <summary>Healthy when written, but not refreshed within twice its own interval.</summary>
    Stale,

    /// <summary>Healthy and fresh: the only state that makes its processor live.</summary>
    Healthy,
}

/// <summary>
/// The one definition of "is this replica live", shared by every reader of the per-instance key: the
/// API's start gate and liveness endpoint, and the orchestrator's fire-time liveness gate.
/// <para>
/// <b>Here, in the contracts leaf, and pure.</b> Both sides reference this assembly and nothing else in
/// common that is free of dependencies, so the rule lives here and takes the raw value as a string —
/// no Redis type crosses into this leaf. Each side does its own read (index, then per-instance GETs)
/// and hands every value to <see cref="Classify"/>, so the two cannot drift on what "live" means: a
/// processor the start gate admits is one the fire gate dispatches to, and the reverse.
/// </para>
/// <para>
/// A processor is live when at least one of its replicas classifies <see cref="ReplicaLiveness.Healthy"/>.
/// </para>
/// </summary>
public static class ReplicaLivenessClassifier
{
    /// <summary>
    /// Classifies one per-instance value. Never throws: the value is external, self-registered data,
    /// so every bad shape is a classification rather than a fault.
    /// </summary>
    /// <param name="raw">The per-instance key's value, or null/empty when the key is absent.</param>
    /// <param name="nowUtc">The reader's clock, in UTC.</param>
    public static ReplicaLiveness Classify(string? raw, DateTime nowUtc)
    {
        if (string.IsNullOrEmpty(raw))
        {
            return ReplicaLiveness.Absent;
        }

        ProcessorLivenessEntry? entry;
        try
        {
            entry = JsonSerializer.Deserialize<ProcessorLivenessEntry>(raw);
        }
        catch (Exception ex) when (ex is JsonException or NotSupportedException)
        {
            return ReplicaLiveness.Malformed;
        }

        if (entry?.Summary is null)
        {
            return ReplicaLiveness.Malformed;
        }

        // Ordinal: the writer is the sole producer and always emits the canonical constant.
        if (!string.Equals(entry.Status, LivenessStatus.Healthy, StringComparison.Ordinal))
        {
            return ReplicaLiveness.Unhealthy;
        }

        if (entry.Timestamp.AddSeconds(entry.Interval * 2) <= nowUtc)
        {
            return ReplicaLiveness.Stale;
        }

        return ReplicaLiveness.Healthy;
    }
}
