using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// Entry-step crons against the real orchestrator: two entry steps of one workflow, each on its own
/// cron (a workflow has no cron of its own), fire at their own rates, every fire under its own
/// correlation id, and a stop silences both. A workflow whose entry step has no cron starts and fires nothing.
/// <para>
/// <b>Self-contained.</b> The workflow and its two steps are created here and deleted in the
/// <c>finally</c>. The only borrowed thing is a live processor: outcome-recorder by default, because it
/// has no config schema (the start's payload gate admits a step without a payload) and as an entry
/// step with no successor it only builds a record and hands it to nobody — no topic, no file share, no
/// bucket. <c>SKP_ENTRY_CRON_PROCESSOR_ID</c> overrides it.
/// </para>
/// <para>
/// <b>Counted from the orchestrator's own record.</b> Each successful dispatch logs
/// "dispatched an entry step" with StepId, WorkflowId and CorrelationId in scope; the count is read
/// from Elasticsearch (<c>SKP_ES_URL</c>) by the template and this run's workflow id, after the
/// ingest lag has settled. Needs <c>SKP_REALSTACK=1</c> and the BaseApi and Elasticsearch forwards.
/// </para>
/// </summary>
[Trait("Category", RealStack.Category)]
public sealed class EntryCronLiveTests
{
    private const string LogIndex = "logs-generic.otel-default";
    private const string EntryDispatched = "dispatched an entry step";
    private const string StepACron = "*/30 * * * * *";
    private const string StepBCron = "*/10 * * * * *";

    private static readonly TimeSpan RunFor = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan QuietFor = TimeSpan.FromSeconds(15);

    /// <summary>A stop answers 202 before the scheduler is torn down; a fire inside this slack is not a leak.</summary>
    private static readonly TimeSpan StopSlack = TimeSpan.FromSeconds(2);

    private static string ElasticUrl => RealStack.Get("SKP_ES_URL", "http://localhost:19200");

    [Fact]
    public async Task TwoEntryCronsFireAtTheirOwnRates()
    {
        RealStack.SkipUnlessEnabled();
        var ct = TestContext.Current.CancellationToken;

        using var http = new HttpClient { BaseAddress = new Uri(RealStack.BaseApiUrl), Timeout = TimeSpan.FromSeconds(20) };
        var processorId = await FindProcessorAsync(http, ct);
        var run = Guid.NewGuid().ToString("N")[..12];

        Guid a = Guid.Empty, b = Guid.Empty, workflow = Guid.Empty;
        var bodyCompleted = false;
        try
        {
            a = await CreateAsync(http, "steps", Step($"entrycron-a-{run}", processorId), ct);
            b = await CreateAsync(http, "steps", Step($"entrycron-b-{run}", processorId), ct);
            workflow = await CreateAsync(http, "workflows", new
            {
                name = $"entrycron-wf-{run}", version = "1.0.0", description = (string?)null,
                entryStepIds = new[] { a, b }, assignmentIds = Array.Empty<Guid>(), cacheIds = Array.Empty<Guid>(),
                entryCrons = new Dictionary<Guid, string> { [a] = StepACron, [b] = StepBCron },
            }, ct);

            // The read echoes the per-step crons, so what fires below is what was stored.
            using (var read = JsonDocument.Parse(await http.GetStringAsync($"/api/v1/workflows/{workflow}", ct)))
            {
                var crons = read.RootElement.GetProperty("entryCrons");
                Assert.Equal(StepBCron, crons.GetProperty(b.ToString("D")).GetString());
                Assert.Equal(StepACron, crons.GetProperty(a.ToString("D")).GetString());
            }

            var started = DateTimeOffset.UtcNow;
            await PostOrchestrationAsync(http, "start", workflow, ct);
            await Task.Delay(RunFor, ct);

            var stopRequested = DateTimeOffset.UtcNow;
            await PostOrchestrationAsync(http, "stop", workflow, ct);
            await Task.Delay(QuietFor, ct);
            var quietEnd = DateTimeOffset.UtcNow;

            var dispatches = await SettledDispatchesAsync(workflow, started, quietEnd, ct);

            var during = dispatches.Where(d => d.At <= stopRequested + StopSlack).ToList();
            var after = dispatches.Where(d => d.At > stopRequested + StopSlack).ToList();

            var perA = during.Count(d => d.StepId == a);
            var perB = during.Count(d => d.StepId == b);
            var summary = string.Join("; ", dispatches.Select(d =>
                $"{d.At:HH:mm:ss.fff} {(d.StepId == a ? "A" : d.StepId == b ? "B" : d.StepId.ToString())} {d.CorrelationId}"));

            Assert.True(perA is >= 1 and <= 3, $"step A (entry cron {StepACron}) fired {perA} times in {RunFor.TotalSeconds}s, expected 2±1: {summary}");
            Assert.True(perB is >= 5 and <= 7, $"step B (entry cron {StepBCron}) fired {perB} times in {RunFor.TotalSeconds}s, expected 6±1: {summary}");
            Assert.True(perB > perA, $"step B's faster cron did not fire more often than step A's: {summary}");

            // One fire is one correlation id: no two dispatches share one, which also proves A's and B's
            // fires at a shared second (:00, :30) are separate fires rather than one fire of both.
            var duplicate = dispatches.GroupBy(d => d.CorrelationId).FirstOrDefault(g => g.Count() > 1);
            Assert.True(duplicate is null, $"correlation id {duplicate?.Key} is on {duplicate?.Count()} dispatches: {summary}");

            Assert.True(after.Count == 0,
                $"{after.Count} dispatch(es) after the stop at {stopRequested:HH:mm:ss.fff} (+{StopSlack.TotalSeconds}s slack): {summary}");
            bodyCompleted = true;
        }
        finally
        {
            // Never throws: a cleanup fault must not replace the test's own failure, nor skip a later delete.
            var problems = await CleanupAsync(workflow, [a, b]);
            foreach (var problem in problems)
            {
                TestContext.Current.TestOutputHelper?.WriteLine($"cleanup: {problem}");
            }

            // Only a run that otherwise passed fails on its leftovers; a failed run already reports its own cause.
            if (bodyCompleted && problems.Count > 0)
            {
                Assert.Fail($"the run passed but left rows behind: {string.Join("; ", problems)}");
            }
        }
    }

    /// <summary>
    /// With no workflow cron left to fall back on, an entry step without a cron of its own is not scheduled:
    /// the start is accepted, and nothing is dispatched for the workflow while it runs. The zero is only read
    /// once ES shows some workflow dispatched in the last few minutes, so a dead ingest cannot pass it.
    /// </summary>
    [Fact]
    public async Task AWorkflowWithNoEntryCronStartsAndDispatchesNothing()
    {
        RealStack.SkipUnlessEnabled();
        var ct = TestContext.Current.CancellationToken;

        using var http = new HttpClient { BaseAddress = new Uri(RealStack.BaseApiUrl), Timeout = TimeSpan.FromSeconds(20) };
        var processorId = await FindProcessorAsync(http, ct);
        var run = Guid.NewGuid().ToString("N")[..12];

        Guid step = Guid.Empty, workflow = Guid.Empty;
        var bodyCompleted = false;
        try
        {
            step = await CreateAsync(http, "steps", Step($"nocron-s-{run}", processorId), ct);
            workflow = await CreateAsync(http, "workflows", new
            {
                name = $"nocron-wf-{run}", version = "1.0.0", description = (string?)null,
                entryStepIds = new[] { step }, assignmentIds = Array.Empty<Guid>(), cacheIds = Array.Empty<Guid>(),
                entryCrons = new Dictionary<Guid, string>(),
            }, ct);

            using (var read = JsonDocument.Parse(await http.GetStringAsync($"/api/v1/workflows/{workflow}", ct)))
            {
                Assert.False(read.RootElement.TryGetProperty("cronExpression", out _), "the workflow read still carries a cronExpression");
                var crons = read.RootElement.TryGetProperty("entryCrons", out var c) && c.ValueKind == JsonValueKind.Object
                    ? c.EnumerateObject().Count()
                    : 0;
                Assert.Equal(0, crons);
            }

            var started = DateTimeOffset.UtcNow;
            await PostOrchestrationAsync(http, "start", workflow, ct);
            await Task.Delay(TimeSpan.FromSeconds(30), ct);

            await PostOrchestrationAsync(http, "stop", workflow, ct);
            await Task.Delay(QuietFor, ct);
            var quietEnd = DateTimeOffset.UtcNow;

            var dispatches = await SettledDispatchesAsync(workflow, started, quietEnd, ct, settleOnEmpty: true);

            // Positive control: zero only means something if ingest is alive. Some workflow on the stack
            // (the user's chain fires every minute) must have logged an entry dispatch in the last few minutes.
            var anyRecent = await RecentDispatchesOfAnyWorkflowAsync(quietEnd - RecentWindow, quietEnd, ct);
            Assert.True(anyRecent > 0,
                $"no workflow logged \"{EntryDispatched}\" in the {RecentWindow.TotalMinutes} minutes before {quietEnd:HH:mm:ss}: "
                + "ingest looks dead, so the zero below proves nothing");

            var summary = string.Join("; ", dispatches.Select(d => $"{d.At:HH:mm:ss.fff} {d.StepId} {d.CorrelationId}"));
            Assert.True(dispatches.Count == 0, $"a workflow with no entry cron dispatched {dispatches.Count} time(s): {summary}");
            bodyCompleted = true;
        }
        finally
        {
            var problems = await CleanupAsync(workflow, [step]);
            foreach (var problem in problems)
            {
                TestContext.Current.TestOutputHelper?.WriteLine($"cleanup: {problem}");
            }

            if (bodyCompleted && problems.Count > 0)
            {
                Assert.Fail($"the run passed but left rows behind: {string.Join("; ", problems)}");
            }
        }
    }

    // Four entry steps in three schedule groups: C shares B's cron, so one group's job dispatches two entries.
    // Fast crons, so a job a stop missed would fire several times inside the quiet window.
    private const string MultiACron = "*/3 * * * * *";
    private const string MultiBCron = "*/5 * * * * *";
    private const string MultiDCron = "*/4 * * * * *";
    private const string FireJobScope = "Orchestrator.Scheduling.WorkflowFireJob";
    private const string Activated = "activated workflow {WorkflowId} with {StepCount} steps in {GroupCount} schedule groups, scheduled={Scheduled}";
    private const string Unscheduled = "unscheduled the workflow's jobs and marked it stopped; steps still in flight will resolve until it is reaped";
    private const string StaleActivation = "this fire belongs to an activation L1 no longer holds; standing down without dispatching";

    /// <summary>A fire already running when its replica unscheduled may still log its stand-down; one later is a live job.</summary>
    private static readonly TimeSpan InFlightSlack = TimeSpan.FromSeconds(1);

    private static int OrchestratorReplicas => int.Parse(RealStack.Get("SKP_ORCHESTRATOR_REPLICAS", "3"), CultureInfo.InvariantCulture);

    /// <summary>
    /// A stop of a workflow with several entry crons tears down every schedule group's job on every orchestrator
    /// replica. Every replica schedules the jobs (only the leader dispatches), so the dispatches alone would only show
    /// the leader stopping: the proof for the others is their own record — each replica that activated the workflow
    /// logs that it unscheduled it, and no fire job of the workflow runs on that replica after that line. A job the
    /// stop missed would fire within the quiet window (the slowest cron is 5 s) and log "not active in L1" at
    /// Information, which ships from every replica.
    /// </summary>
    [Fact]
    public async Task AStopTearsDownEveryEntryJobOnEveryReplica()
    {
        RealStack.SkipUnlessEnabled();
        var ct = TestContext.Current.CancellationToken;

        using var http = new HttpClient { BaseAddress = new Uri(RealStack.BaseApiUrl), Timeout = TimeSpan.FromSeconds(20) };
        var processorId = await FindProcessorAsync(http, ct);
        var run = Guid.NewGuid().ToString("N")[..12];

        Guid a = Guid.Empty, b = Guid.Empty, c = Guid.Empty, d = Guid.Empty, workflow = Guid.Empty;
        var bodyCompleted = false;
        try
        {
            (workflow, a, b, c, d) = await CreateMultiCronWorkflowAsync(http, processorId, $"stopall-{run}", ct);

            var started = DateTimeOffset.UtcNow;
            await PostOrchestrationAsync(http, "start", workflow, ct);
            await Task.Delay(TimeSpan.FromSeconds(30), ct);

            var stopRequested = DateTimeOffset.UtcNow;
            await PostOrchestrationAsync(http, "stop", workflow, ct);
            await Task.Delay(TimeSpan.FromSeconds(30), ct);
            var quietEnd = DateTimeOffset.UtcNow;

            var dispatches = await SettledDispatchesAsync(workflow, started, quietEnd, ct);
            var records = await SettledRecordsAsync(workflow, started, quietEnd, ct);
            var summary = Describe(dispatches, records, a, b, c, d);

            // While it ran, every entry dispatched: all three groups were scheduled and fired.
            var during = dispatches.Where(x => x.At <= stopRequested + StopSlack).ToList();
            foreach (var (step, label) in new[] { (a, "A"), (b, "B"), (c, "C"), (d, "D") })
            {
                Assert.True(during.Count(x => x.StepId == step) >= 3, $"entry {label} dispatched fewer than 3 times in 30 s: {summary}");
            }
            Assert.True(Math.Abs(during.Count(x => x.StepId == b) - during.Count(x => x.StepId == c)) <= 1,
                $"B and C share one cron (one group) but dispatched different counts: {summary}");

            // Nothing dispatched after the stop.
            var after = dispatches.Where(x => x.At > stopRequested + StopSlack).ToList();
            Assert.True(after.Count == 0, $"{after.Count} dispatch(es) after the stop at {stopRequested:HH:mm:ss.fff}: {summary}");

            // Every replica activated it, with three groups, and every one of them unscheduled it.
            var activated = records.Where(r => r.Template == Activated).ToList();
            var activatedOn = activated.Select(r => r.Instance).ToHashSet();
            Assert.True(activatedOn.Count == OrchestratorReplicas,
                $"{activatedOn.Count} orchestrator replica(s) activated the workflow ({string.Join(", ", activatedOn)}), expected {OrchestratorReplicas}: {summary}");
            Assert.All(activated, r => Assert.Equal("3", r.Attribute("GroupCount")));

            var unscheduledAt = records.Where(r => r.Template == Unscheduled)
                .GroupBy(r => r.Instance).ToDictionary(g => g.Key, g => g.Min(r => r.At));
            Assert.True(activatedOn.SetEquals(unscheduledAt.Keys),
                $"activated on [{string.Join(", ", activatedOn.Order())}] but unscheduled on [{string.Join(", ", unscheduledAt.Keys.Order())}]: {summary}");

            // On no replica does a fire job of the workflow run after that replica unscheduled it.
            var leaked = records
                .Where(r => r.Scope == FireJobScope && unscheduledAt.TryGetValue(r.Instance, out var at) && r.At > at + InFlightSlack)
                .ToList();
            Assert.True(leaked.Count == 0, $"{leaked.Count} fire(s) after their replica unscheduled the workflow: {summary}");
            bodyCompleted = true;
        }
        finally
        {
            await CleanupOrFailAsync(workflow, [a, b, c, d], bodyCompleted);
        }
    }

    /// <summary>
    /// A start after a stop runs only the new activation's jobs: a job the stop left behind would either fire beside the
    /// new one (an entry dispatched twice in one tick) or stand down as a stale activation. Neither may happen, and the
    /// second stop is as clean as the first.
    /// </summary>
    [Fact]
    public async Task ARestartAfterAStopRunsOnlyTheNewActivationsJobs()
    {
        RealStack.SkipUnlessEnabled();
        var ct = TestContext.Current.CancellationToken;

        using var http = new HttpClient { BaseAddress = new Uri(RealStack.BaseApiUrl), Timeout = TimeSpan.FromSeconds(20) };
        var processorId = await FindProcessorAsync(http, ct);
        var run = Guid.NewGuid().ToString("N")[..12];

        Guid a = Guid.Empty, b = Guid.Empty, c = Guid.Empty, d = Guid.Empty, workflow = Guid.Empty;
        var bodyCompleted = false;
        try
        {
            (workflow, a, b, c, d) = await CreateMultiCronWorkflowAsync(http, processorId, $"restart-{run}", ct);

            var started = DateTimeOffset.UtcNow;
            await PostOrchestrationAsync(http, "start", workflow, ct);
            await Task.Delay(TimeSpan.FromSeconds(15), ct);
            await PostOrchestrationAsync(http, "stop", workflow, ct);
            await Task.Delay(TimeSpan.FromSeconds(5), ct);

            var restarted = DateTimeOffset.UtcNow;
            await PostOrchestrationAsync(http, "start", workflow, ct);
            await Task.Delay(TimeSpan.FromSeconds(30), ct);

            var stopRequested = DateTimeOffset.UtcNow;
            await PostOrchestrationAsync(http, "stop", workflow, ct);
            await Task.Delay(TimeSpan.FromSeconds(20), ct);
            var quietEnd = DateTimeOffset.UtcNow;

            var dispatches = await SettledDispatchesAsync(workflow, started, quietEnd, ct);
            var records = await SettledRecordsAsync(workflow, started, quietEnd, ct);
            var summary = Describe(dispatches, records, a, b, c, d);

            // The second run: every entry fires, and none twice in one tick (a leftover job would double it).
            var second = dispatches.Where(x => x.At > restarted + StopSlack && x.At <= stopRequested + StopSlack).ToList();
            foreach (var (step, label) in new[] { (a, "A"), (b, "B"), (c, "C"), (d, "D") })
            {
                var ticks = second.Where(x => x.StepId == step).Select(x => x.At.ToUnixTimeSeconds()).ToList();
                Assert.True(ticks.Count >= 4, $"entry {label} dispatched {ticks.Count} time(s) in the second 30 s run: {summary}");
                Assert.True(ticks.Count == ticks.Distinct().Count(), $"entry {label} dispatched twice in one tick after the restart: {summary}");
            }

            var stale = records.Where(r => r.Template == StaleActivation && r.At > restarted).ToList();
            Assert.True(stale.Count == 0, $"{stale.Count} fire(s) of the first activation ran after the restart: {summary}");

            // Every replica activated twice and unscheduled twice.
            foreach (var replica in records.Where(r => r.Template == Activated).GroupBy(r => r.Instance))
            {
                Assert.True(replica.Count() == 2, $"{replica.Key} activated {replica.Count()} time(s), expected 2: {summary}");
                Assert.True(records.Count(r => r.Template == Unscheduled && r.Instance == replica.Key) == 2,
                    $"{replica.Key} did not log two unschedules: {summary}");
            }

            var after = dispatches.Where(x => x.At > stopRequested + StopSlack).ToList();
            Assert.True(after.Count == 0, $"{after.Count} dispatch(es) after the second stop at {stopRequested:HH:mm:ss.fff}: {summary}");
            var lastUnscheduled = records.Where(r => r.Template == Unscheduled && r.At > stopRequested)
                .GroupBy(r => r.Instance).ToDictionary(g => g.Key, g => g.Min(r => r.At));
            var leaked = records
                .Where(r => r.Scope == FireJobScope && lastUnscheduled.TryGetValue(r.Instance, out var at) && r.At > at + InFlightSlack)
                .ToList();
            Assert.True(leaked.Count == 0, $"{leaked.Count} fire(s) after the second stop's unschedule: {summary}");
            bodyCompleted = true;
        }
        finally
        {
            await CleanupOrFailAsync(workflow, [a, b, c, d], bodyCompleted);
        }
    }

    /// <summary>Four entry steps A..D, crons A=3 s, B=C=5 s (one group), D=4 s; the read must echo them.</summary>
    private static async Task<(Guid Workflow, Guid A, Guid B, Guid C, Guid D)> CreateMultiCronWorkflowAsync(
        HttpClient http, Guid processorId, string run, CancellationToken ct)
    {
        var a = await CreateAsync(http, "steps", Step($"{run}-a", processorId), ct);
        var b = await CreateAsync(http, "steps", Step($"{run}-b", processorId), ct);
        var c = await CreateAsync(http, "steps", Step($"{run}-c", processorId), ct);
        var d = await CreateAsync(http, "steps", Step($"{run}-d", processorId), ct);
        var crons = new Dictionary<Guid, string> { [a] = MultiACron, [b] = MultiBCron, [c] = MultiBCron, [d] = MultiDCron };
        var workflow = await CreateAsync(http, "workflows", new
        {
            name = $"{run}-wf", version = "1.0.0", description = (string?)null,
            entryStepIds = new[] { a, b, c, d }, assignmentIds = Array.Empty<Guid>(), cacheIds = Array.Empty<Guid>(),
            entryCrons = crons,
        }, ct);

        using var read = JsonDocument.Parse(await http.GetStringAsync($"/api/v1/workflows/{workflow}", ct));
        var stored = read.RootElement.GetProperty("entryCrons");
        foreach (var (step, cron) in crons)
        {
            Assert.Equal(cron, stored.GetProperty(step.ToString("D")).GetString());
        }

        return (workflow, a, b, c, d);
    }

    private static async Task CleanupOrFailAsync(Guid workflow, Guid[] steps, bool bodyCompleted)
    {
        var problems = await CleanupAsync(workflow, steps);
        foreach (var problem in problems)
        {
            TestContext.Current.TestOutputHelper?.WriteLine($"cleanup: {problem}");
        }

        if (bodyCompleted && problems.Count > 0)
        {
            Assert.Fail($"the run passed but left rows behind: {string.Join("; ", problems)}");
        }
    }

    private static string Describe(List<Dispatch> dispatches, List<LogRecord> records, Guid a, Guid b, Guid c, Guid d)
    {
        string Label(Guid s) => s == a ? "A" : s == b ? "B" : s == c ? "C" : s == d ? "D" : s.ToString();
        var lines = dispatches.Select(x => (x.At, Text: $"dispatch {Label(x.StepId)}"))
            .Concat(records.Where(r => r.Template != EntryDispatched).Select(r => (r.At, Text: $"{r.Instance} {r.Template.Split(';')[0]}")))
            .OrderBy(x => x.At)
            .Select(x => $"{x.At:HH:mm:ss.fff} {x.Text}");
        return "\n" + string.Join("\n", lines);
    }

    private sealed record LogRecord(DateTimeOffset At, string Instance, string Scope, string Template, JsonElement Attributes)
    {
        public string? Attribute(string name) =>
            Attributes.TryGetProperty(name, out var v) ? (v.ValueKind == JsonValueKind.String ? v.GetString() : v.GetRawText()) : null;
    }

    /// <summary>
    /// Every orchestrator record of this workflow in the window, from every replica, read until two polls agree (as
    /// <see cref="SettledDispatchesAsync"/>): its replica (<c>service.instance.id</c>), logger and message template.
    /// </summary>
    private static async Task<List<LogRecord>> SettledRecordsAsync(Guid workflow, DateTimeOffset from, DateTimeOffset to, CancellationToken ct)
    {
        using var http = new HttpClient { BaseAddress = new Uri(ElasticUrl), Timeout = TimeSpan.FromSeconds(20) };
        var gte = from.AddSeconds(-5).ToUnixTimeMilliseconds();
        var lte = to.AddSeconds(5).ToUnixTimeMilliseconds();
        var query = $$$"""
        {
          "size": 2000,
          "sort": [{"@timestamp": "asc"}],
          "_source": ["@timestamp", "resource.attributes.service.instance.id", "scope.name", "attributes"],
          "query": {"bool": {"filter": [
            {"term": {"resource.attributes.service.name": "orchestrator"}},
            {"term": {"attributes.WorkflowId": "{{{workflow:D}}}"}},
            {"range": {"@timestamp": {"gte": {{{gte}}}, "lte": {{{lte}}}, "format": "epoch_millis"} } }
          ]} }
        }
        """;

        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(60);
        List<LogRecord>? previous = null;
        while (true)
        {
            using var response = await http.PostAsync($"/{LogIndex}/_search",
                new StringContent(query, Encoding.UTF8, "application/json"), ct);
            var text = await response.Content.ReadAsStringAsync(ct);
            Assert.True(response.IsSuccessStatusCode, $"elasticsearch search returned {(int)response.StatusCode}: {text}");

            using var body = JsonDocument.Parse(text);
            var current = body.RootElement.GetProperty("hits").GetProperty("hits").EnumerateArray()
                .Select(h => h.GetProperty("_source"))
                .Select(s =>
                {
                    var attributes = s.GetProperty("attributes").Clone();
                    return new LogRecord(
                        ParseTimestamp(s.GetProperty("@timestamp")),
                        s.GetProperty("resource").GetProperty("attributes").GetProperty("service.instance.id").GetString()!,
                        s.TryGetProperty("scope", out var scope) && scope.TryGetProperty("name", out var n) ? n.GetString()! : "",
                        attributes.TryGetProperty("{OriginalFormat}", out var f) ? f.GetString()! : "",
                        attributes);
                })
                .ToList();

            if ((previous is not null && previous.Count == current.Count && current.Count > 0) || DateTime.UtcNow > deadline)
            {
                return current;
            }

            previous = current;
            await Task.Delay(TimeSpan.FromSeconds(5), ct);
        }
    }

    private static readonly TimeSpan CleanupBudget = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan CleanupRetry = TimeSpan.FromSeconds(2);

    /// <summary>
    /// Stop, then delete the workflow, then its steps, each delete retried until it succeeds (or the row is
    /// already gone) within one bounded budget of its own — not the test's token, which may be what failed.
    /// <para>
    /// <b>The retry is for the stop.</b> It answers 202 and is applied asynchronously, so a delete sent straight
    /// after can be refused while the workflow still reads running, and the step deletes are then refused because
    /// the workflow still references them. Returns every non-success instead of discarding it.
    /// </para>
    /// </summary>
    private static async Task<List<string>> CleanupAsync(Guid workflow, Guid[] steps)
    {
        var problems = new List<string>();
        using var budget = new CancellationTokenSource(CleanupBudget);
        using var http = new HttpClient { BaseAddress = new Uri(RealStack.BaseApiUrl), Timeout = TimeSpan.FromSeconds(10) };

        if (workflow != Guid.Empty)
        {
            try
            {
                using var stop = await http.PostAsJsonAsync("/api/v1/orchestration/stop", workflow, budget.Token);
                if (!stop.IsSuccessStatusCode)
                {
                    problems.Add($"stop {workflow:D} -> {(int)stop.StatusCode}: {await ReadSafeAsync(stop)}");
                }
            }
            catch (Exception ex)
            {
                problems.Add($"stop {workflow:D} threw {ex.GetType().Name}: {ex.Message}");
            }

            await DeleteUntilGoneAsync(http, $"/api/v1/workflows/{workflow:D}", problems, budget.Token);
        }

        foreach (var id in steps.Where(id => id != Guid.Empty))
        {
            await DeleteUntilGoneAsync(http, $"/api/v1/steps/{id:D}", problems, budget.Token);
        }

        return problems;
    }

    /// <summary>Retries a delete until 2xx or 404; records only the last refusal if the budget runs out.</summary>
    private static async Task DeleteUntilGoneAsync(HttpClient http, string path, List<string> problems, CancellationToken budget)
    {
        string? last = null;
        while (true)
        {
            try
            {
                using var response = await http.DeleteAsync(path, budget);
                if (response.IsSuccessStatusCode || response.StatusCode == HttpStatusCode.NotFound)
                {
                    return;
                }

                last = $"DELETE {path} -> {(int)response.StatusCode}: {await ReadSafeAsync(response)}";
            }
            catch (Exception ex) when (!budget.IsCancellationRequested)
            {
                last = $"DELETE {path} threw {ex.GetType().Name}: {ex.Message}";
            }
            catch (Exception)
            {
                break;
            }

            try
            {
                await Task.Delay(CleanupRetry, budget);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }

        problems.Add(last ?? $"DELETE {path} did not complete within {CleanupBudget.TotalSeconds}s");
    }

    private static async Task<string> ReadSafeAsync(HttpResponseMessage response)
    {
        try
        {
            return await response.Content.ReadAsStringAsync();
        }
        catch (Exception ex)
        {
            return $"(body unreadable: {ex.GetType().Name})";
        }
    }

    private sealed record Dispatch(DateTimeOffset At, Guid StepId, string CorrelationId);

    /// <summary>
    /// This workflow's entry dispatches in the window, read until two polls agree. Ingest runs
    /// seconds behind, so one immediate query would undercount the last fires before the stop.
    /// An empty result only settles when <paramref name="settleOnEmpty"/> says none is the expected answer.
    /// </summary>
    private static async Task<List<Dispatch>> SettledDispatchesAsync(
        Guid workflow, DateTimeOffset from, DateTimeOffset to, CancellationToken ct, bool settleOnEmpty = false)
    {
        using var http = new HttpClient { BaseAddress = new Uri(ElasticUrl), Timeout = TimeSpan.FromSeconds(20) };
        var gte = from.AddSeconds(-5).ToUnixTimeMilliseconds();
        var lte = to.AddSeconds(5).ToUnixTimeMilliseconds();
        var query = $$$"""
        {
          "size": 200,
          "sort": [{"@timestamp": "asc"}],
          "_source": ["@timestamp", "attributes.StepId", "attributes.CorrelationId"],
          "query": {"bool": {"filter": [
            {"term": {"attributes.{OriginalFormat}": "{{{EntryDispatched}}}"}},
            {"term": {"attributes.WorkflowId": "{{{workflow:D}}}"}},
            {"range": {"@timestamp": {"gte": {{{gte}}}, "lte": {{{lte}}}, "format": "epoch_millis"} } }
          ]} }
        }
        """;

        // The stop happened QuietFor ago, so everything before it has had that long to land; two
        // agreeing polls a few seconds apart, after a floor wait, cover the measured 7-14s lag.
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(60);
        List<Dispatch>? previous = null;
        await Task.Delay(TimeSpan.FromSeconds(10), ct);
        while (true)
        {
            using var response = await http.PostAsync($"/{LogIndex}/_search",
                new StringContent(query, Encoding.UTF8, "application/json"), ct);
            var text = await response.Content.ReadAsStringAsync(ct);
            Assert.True(response.IsSuccessStatusCode, $"elasticsearch search returned {(int)response.StatusCode}: {text}");

            using var body = JsonDocument.Parse(text);
            var current = body.RootElement.GetProperty("hits").GetProperty("hits").EnumerateArray()
                .Select(h => h.GetProperty("_source"))
                .Select(s => new Dispatch(
                    ParseTimestamp(s.GetProperty("@timestamp")),
                    Guid.Parse(s.GetProperty("attributes").GetProperty("StepId").GetString()!),
                    s.GetProperty("attributes").GetProperty("CorrelationId").GetString()!))
                .ToList();

            if ((previous is not null && previous.Count == current.Count && (current.Count > 0 || settleOnEmpty))
                || DateTime.UtcNow > deadline)
            {
                return current;
            }

            previous = current;
            await Task.Delay(TimeSpan.FromSeconds(5), ct);
        }
    }

    private static readonly TimeSpan RecentWindow = TimeSpan.FromMinutes(5);

    /// <summary>How many entry dispatches ANY workflow logged in the window (a read-only count).</summary>
    private static async Task<long> RecentDispatchesOfAnyWorkflowAsync(DateTimeOffset from, DateTimeOffset to, CancellationToken ct)
    {
        using var http = new HttpClient { BaseAddress = new Uri(ElasticUrl), Timeout = TimeSpan.FromSeconds(20) };
        var query = $$$"""
        {
          "size": 0,
          "track_total_hits": true,
          "query": {"bool": {"filter": [
            {"term": {"attributes.{OriginalFormat}": "{{{EntryDispatched}}}"}},
            {"range": {"@timestamp": {"gte": {{{from.ToUnixTimeMilliseconds()}}}, "lte": {{{to.ToUnixTimeMilliseconds()}}}, "format": "epoch_millis"} } }
          ]} }
        }
        """;
        using var response = await http.PostAsync($"/{LogIndex}/_search",
            new StringContent(query, Encoding.UTF8, "application/json"), ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        Assert.True(response.IsSuccessStatusCode, $"elasticsearch search returned {(int)response.StatusCode}: {text}");

        using var body = JsonDocument.Parse(text);
        return body.RootElement.GetProperty("hits").GetProperty("total").GetProperty("value").GetInt64();
    }

    /// <summary>The collector writes @timestamp as epoch milliseconds with a fraction, as a string.</summary>
    private static DateTimeOffset ParseTimestamp(JsonElement value)
    {
        var raw = value.ValueKind == JsonValueKind.String ? value.GetString()! : value.GetRawText();
        if (double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var ms))
        {
            return DateTimeOffset.FromUnixTimeMilliseconds((long)ms);
        }

        return DateTimeOffset.Parse(raw, CultureInfo.InvariantCulture);
    }

    /// <summary>The override, else the outcome-recorder, provided a replica of it is live.</summary>
    private static async Task<Guid> FindProcessorAsync(HttpClient http, CancellationToken ct)
    {
        if (Guid.TryParse(RealStack.Get("SKP_ENTRY_CRON_PROCESSOR_ID", ""), out var configured))
        {
            return configured;
        }

        using var liveness = JsonDocument.Parse(await http.GetStringAsync("/api/v1/processors/liveness", ct));
        var live = liveness.RootElement.EnumerateArray()
            .Where(p => p.GetProperty("live").GetBoolean())
            .Select(p => p.GetProperty("processorId").GetGuid())
            .ToHashSet();

        using var processors = JsonDocument.Parse(await http.GetStringAsync("/api/v1/processors", ct));
        var root = processors.RootElement.ValueKind == JsonValueKind.Array
            ? processors.RootElement
            : processors.RootElement.GetProperty("items");
        var recorder = root.EnumerateArray()
            .Where(p => p.GetProperty("name").GetString() == "outcome-recorder" && live.Contains(p.GetProperty("id").GetGuid()))
            .Select(p => p.GetProperty("id").GetGuid())
            .FirstOrDefault();

        Assert.True(recorder != Guid.Empty, "no live outcome-recorder processor; set SKP_ENTRY_CRON_PROCESSOR_ID to a fast, harmless live processor");
        return recorder;
    }

    private static object Step(string name, Guid processorId) => new
    {
        name, version = "1.0.0", description = (string?)null, processorId,
        nextStepIds = Array.Empty<Guid>(), entryCondition = 4,
    };

    private static async Task<Guid> CreateAsync(HttpClient http, string resource, object body, CancellationToken ct)
    {
        using var response = await http.PostAsJsonAsync($"/api/v1/{resource}", body, ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        Assert.True(response.IsSuccessStatusCode, $"POST /api/v1/{resource} returned {(int)response.StatusCode}: {text}");
        using var doc = JsonDocument.Parse(text);
        return doc.RootElement.GetProperty("id").GetGuid();
    }

    private static async Task PostOrchestrationAsync(HttpClient http, string verb, Guid workflow, CancellationToken ct)
    {
        using var response = await http.PostAsJsonAsync($"/api/v1/orchestration/{verb}", workflow, ct);
        Assert.True(response.StatusCode == HttpStatusCode.Accepted || response.IsSuccessStatusCode,
            $"{verb} returned {(int)response.StatusCode}: {await response.Content.ReadAsStringAsync(ct)}");
    }
}
