namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// Waits until the window has stopped growing in Elasticsearch.
/// <para>
/// <b>A stability poll, not a fixed sleep.</b> OTLP export, collector batching and index refresh
/// together give a variable ingest lag; a fixed sleep either wastes minutes or reads a half-ingested
/// window and reports lost steps that are still in flight.
/// </para>
/// </summary>
internal static class StabilityWaiter
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan Budget = TimeSpan.FromMinutes(3);

    /// <summary>
    /// Returns once two consecutive counts ten seconds apart agree, or throws when the budget runs
    /// out — a window that never settles is a broken pipeline, not a slow one, and saying so beats
    /// verifying against a moving target.
    /// </summary>
    public static async Task WaitForStableIngestAsync(
        ElasticLogReader reader, DateTimeOffset from, DateTimeOffset to, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reader);

        var deadline = DateTimeOffset.UtcNow + Budget;
        var previous = -1L;

        while (DateTimeOffset.UtcNow < deadline)
        {
            var current = await reader.CountAsync(from, to, ct);
            if (current == previous && current > 0)
            {
                return;
            }

            previous = current;
            await Task.Delay(PollInterval, ct);
        }

        throw new TimeoutException(
            $"the window {from:o}..{to:o} was still growing after {Budget.TotalMinutes} minutes; "
            + "elasticsearch ingest has not settled and no verdict can be trusted");
    }
}
