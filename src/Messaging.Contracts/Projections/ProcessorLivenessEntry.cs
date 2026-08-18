using System.Text.Json.Serialization;

namespace Messaging.Contracts.Projections;

/// <summary>
/// L2 per-instance processor-liveness value for the <c>skp:proc:{processorId}:{instanceId}</c> key.
/// Liveness-only by construction: it carries no input or output schema definitions. Kept separate
/// from the shared <see cref="LivenessProjection"/> so the workflow-root path is untouched.
/// <para>
/// <see cref="Status"/> is derived from <see cref="Summary"/> by <see cref="Create"/>, which is the
/// only sanctioned construction path. The positional constructor stays public solely so the
/// deserializer can use it. The <c>[property: ...]</c> attribute targets are load-bearing.
/// </para>
/// </summary>
public sealed record ProcessorLivenessEntry(
    [property: JsonPropertyName("timestamp")] DateTime Timestamp,
    [property: JsonPropertyName("interval")]  int Interval,
    [property: JsonPropertyName("status")]    string Status,
    [property: JsonPropertyName("summary")]   LivenessSummary Summary)
{
    /// <summary>
    /// The single enforcement point for the status-matches-summary invariant. Each per-schema
    /// outcome is a <see cref="SchemaOutcome"/> string, or null meaning the schema id is absent and
    /// the check is skipped, which counts as success. Any failure makes the status unhealthy;
    /// otherwise it is healthy. Feeding outcomes through here means a caller cannot produce a status
    /// that contradicts its summary.
    /// </summary>
    public static ProcessorLivenessEntry Create(
        string? inputOutcome,
        string? outputOutcome,
        string? configOutcome,
        DateTime timestamp,
        int interval)
    {
        var input  = inputOutcome  ?? SchemaOutcome.Success;
        var output = outputOutcome ?? SchemaOutcome.Success;
        var config = configOutcome ?? SchemaOutcome.Success;

        var summary = new LivenessSummary(input, output, config);

        var anyFail = input  == SchemaOutcome.Fail
                   || output == SchemaOutcome.Fail
                   || config == SchemaOutcome.Fail;

        var status = anyFail ? LivenessStatus.Unhealthy : LivenessStatus.Healthy;

        return new ProcessorLivenessEntry(timestamp, interval, status, summary);
    }
}

/// <summary>
/// Per-schema liveness summary — each field is a <see cref="SchemaOutcome"/> string. The config
/// outcome is decided once at startup and never recomputed; an absent config schema id counts as
/// success. The <c>[property: ...]</c> attribute targets are load-bearing.
/// </summary>
public sealed record LivenessSummary(
    [property: JsonPropertyName("inputSchema")]  string InputSchema,
    [property: JsonPropertyName("outputSchema")] string OutputSchema,
    [property: JsonPropertyName("configSchema")] string ConfigSchema);
