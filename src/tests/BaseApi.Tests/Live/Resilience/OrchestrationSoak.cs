using System.Net.Http.Json;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>What fault a scenario injects, and how.</summary>
/// <param name="Kind">Which dependency goes away, for the witness to look for.</param>
/// <param name="Inject">Applies the fault and returns the handle whose disposal releases it.</param>
internal sealed record FaultSchedule(
    FaultKind Kind,
    Func<CancellationToken, Task<IAsyncDisposable>> Inject)
{
    public static readonly FaultSchedule None =
        new(FaultKind.None, _ => Task.FromResult<IAsyncDisposable>(new NoFault()));

    private sealed class NoFault : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}

/// <summary>Everything one soak observed.</summary>
internal sealed record SoakResult(
    IReadOnlyList<RunClassification> Runs,
    FaultWindow Window,
    IReadOnlyDictionary<string, double?> Metrics,
    DateTimeOffset StartedAt,
    DateTimeOffset StoppedAt);

/// <summary>
/// The five-minute skeleton every scenario shares: drain, start, inject at 150s, release at 210s,
/// stop at 300s, settle, then read one window out of Elasticsearch and classify every run in it.
/// <para>
/// <b>The fault sits at 150-210s deliberately.</b> At a thirty-second cron that leaves roughly five
/// clean runs before it, two straddling it, and three after — and it is the last group that proves
/// recovery, which is the assertion a shorter soak cannot make.
/// </para>
/// </summary>
internal static class OrchestrationSoak
{
    private static readonly TimeSpan DrainCheck = TimeSpan.FromSeconds(40);
    private static readonly TimeSpan InjectAt = TimeSpan.FromSeconds(150);
    private static readonly TimeSpan ReleaseAt = TimeSpan.FromSeconds(210);
    private static readonly TimeSpan StopAt = TimeSpan.FromSeconds(300);
    private static readonly TimeSpan Settle = TimeSpan.FromSeconds(60);

    /// <summary>
    /// Waited after the initial stop and before the drain check, so the check queries Elasticsearch
    /// rather than the cluster. A run completes in about a second and the cron is thirty seconds, so
    /// twenty seconds after a stop guarantees the cluster itself has gone quiet; but
    /// <see cref="AssertDrainedAsync"/> does not ask the cluster, it asks Elasticsearch, which lags
    /// ingest behind the event. Without this wait, a dispatch fired a few seconds before the stop can
    /// still be unindexed when the drain check runs, so the check passes while a run is genuinely in
    /// flight. That run's tail then lands inside the soak's own window and reads as a truncated run —
    /// an unaccounted loss that is really just ingest lag, a false failure in exactly the conditions
    /// this suite exists to test.
    /// </summary>
    private static readonly TimeSpan DrainSettle = TimeSpan.FromSeconds(20);

    public static async Task<SoakResult> RunAsync(FaultSchedule schedule, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(schedule);

        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        var reader = new ElasticLogReader(http);
        var prometheus = new PromReader(http);

        await StopWorkflowAsync(http, ct);
        await Task.Delay(DrainSettle, ct);
        await AssertDrainedAsync(reader, ct);

        var startedAt = DateTimeOffset.UtcNow;

        DateTimeOffset injectedAt;

        try
        {
            // Start lives inside this try, not before it: if the start's POST lands server-side but
            // the response is lost to a dropped port-forward or a client-side timeout, the exception
            // still routes through this finally and stops the workflow. Without that, a lost response
            // leaves the workflow firing every thirty seconds into whatever scenario runs next, and
            // that scenario's AssertDrainedAsync fails for a reason invisible in its own run.
            await StartWorkflowAsync(http, ct);

            await Task.Delay(InjectAt, ct);

            injectedAt = DateTimeOffset.UtcNow;
            var fault = await schedule.Inject(ct);

            try
            {
                await Task.Delay(ReleaseAt - InjectAt, ct);
            }
            finally
            {
                // Released before the soak's remaining time, and unconditionally: a scenario that
                // threw mid-window must still hand the cluster back.
                await fault.DisposeAsync();
            }

            await Task.Delay(StopAt - ReleaseAt, ct);
        }
        finally
        {
            // Safe even when the start above never ran or never landed: stopping a workflow that
            // isn't running is idempotent -- 202 Accepted, with the orchestrator logging that it
            // wasn't holding it.
            //
            // A fresh, short-budget token here rather than the scenario's own ct: if the scenario was
            // cancelled or timed out, ct is already cancelled and passing it through would make this
            // call throw immediately -- skipping the one stop this finally exists to guarantee, and
            // leaving the workflow firing every thirty seconds. ClusterControl's release path takes
            // the same precaution for the same reason.
            using var stop = new CancellationTokenSource(TimeSpan.FromMinutes(1));
            await StopWorkflowAsync(http, stop.Token);
        }

        var stoppedAt = DateTimeOffset.UtcNow;
        var windowEnd = stoppedAt + Settle;

        await Task.Delay(Settle, ct);
        await StabilityWaiter.WaitForStableIngestAsync(reader, startedAt, windowEnd, ct);

        var window = await FaultWitness.WitnessAsync(
            reader, schedule.Kind, injectedAt, windowEnd, ct);

        var records = await reader.ReadRunRecordsAsync(Chaos.WorkflowId, startedAt, windowEnd, ct);

        // Process-scoped excuses carry no CorrelationId (GatedQueueConsumer logs them above the
        // deserialization boundary), so they cannot be read off any one run's own records. Read once
        // for the whole fault window instead, and offer the same set to every straddling run's
        // classification. On the happy path the window is FaultWitness's None, so there is nothing
        // to fetch and this stays empty -- an extra Elasticsearch round trip S1 has no use for.
        IReadOnlyList<string> windowExcuses = [];

        if (!window.IsNone)
        {
            var windowExcuseRecords = await reader.ReadTemplateRecordsAsync(
                Templates.ProcessScopedExcuses, window.FaultAt, window.HealedAt, ct);

            windowExcuses = windowExcuseRecords
                .Select(r => r.Template)
                .Distinct(StringComparer.Ordinal)
                .ToList();
        }

        var runs = records
            .Where(r => r.CorrelationId is not null)
            .GroupBy(r => r.CorrelationId!, StringComparer.Ordinal)
            .Select(g =>
            {
                var run = g.ToList();
                return RunClassifier.Classify(
                    RunLedger.From(g.Key, run, WorkflowShape.V8FanoutProof), run, window, windowExcuses);
            })
            .OrderBy(c => c.Ledger.StartedAt)
            .ToList();

        return new SoakResult(
            runs, window, await prometheus.CorroborationAsync(ct), startedAt, stoppedAt);
    }

    /// <summary>
    /// Refuses to start on top of a run already in progress. It cannot catch a run someone else
    /// starts mid-soak — this suite assumes exclusive use of the cluster and says so rather than
    /// pretending to detect it.
    /// </summary>
    private static async Task AssertDrainedAsync(ElasticLogReader reader, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var recent = await reader.ReadTemplateRecordsAsync(
            [Templates.EntryDispatched], now - DrainCheck, now, ct);

        if (recent.Count > 0)
        {
            throw new InvalidOperationException(
                $"{recent.Count} entry dispatch(es) in the last {DrainCheck.TotalSeconds}s: the "
                + "workflow is still firing. Stop it and let it drain before starting a scenario.");
        }
    }

    private static async Task StartWorkflowAsync(HttpClient http, CancellationToken ct)
    {
        using var response = await http.PostAsJsonAsync(
            $"{RealStack.BaseApiUrl}/api/v1/orchestration/start", Chaos.WorkflowId, ct);

        response.EnsureSuccessStatusCode();
    }

    private static async Task StopWorkflowAsync(HttpClient http, CancellationToken ct)
    {
        using var response = await http.PostAsJsonAsync(
            $"{RealStack.BaseApiUrl}/api/v1/orchestration/stop", Chaos.WorkflowId, ct);

        response.EnsureSuccessStatusCode();
    }
}
