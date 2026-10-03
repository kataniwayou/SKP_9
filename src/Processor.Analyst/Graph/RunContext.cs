namespace Processor.Analyst.Graph;

/// <summary>A deploy marker: the orchestrator re-activated the workflow in this minute without a start.</summary>
internal sealed record DeployMarker(DateTimeOffset Minute, int Replicas);

/// <summary>
/// Where the target's current run began and how far back evidence may be read. Read by the processor,
/// never by the model, so the limit is known before the first turn (spec U9, D4).
/// </summary>
internal sealed record RunContext(
    DateTimeOffset? Start, DateTimeOffset? HistoryLimit, IReadOnlyList<DeployMarker> Deploys, string? Unavailable)
{
    internal static RunContext Missing(string why) => new(null, null, [], why);
}

internal interface IRunContextSource
{
    Task<RunContext> ReadAsync(Guid workflowId, DateTimeOffset now, CancellationToken ct);
}
