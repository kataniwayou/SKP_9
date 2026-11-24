using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// Entry-step crons against the real orchestrator: two entry steps of one workflow, one on the
/// workflow's cron and one on its own, each fire at their own rate, every fire under its own
/// correlation id, and a stop silences both.
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
    private const string WorkflowCron = "*/30 * * * * *";
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
        try
        {
            a = await CreateAsync(http, "steps", Step($"entrycron-a-{run}", processorId), ct);
            b = await CreateAsync(http, "steps", Step($"entrycron-b-{run}", processorId), ct);
            workflow = await CreateAsync(http, "workflows", new
            {
                name = $"entrycron-wf-{run}", version = "1.0.0", description = (string?)null,
                entryStepIds = new[] { a, b }, assignmentIds = Array.Empty<Guid>(), cacheIds = Array.Empty<Guid>(),
                cronExpression = WorkflowCron,
                entryCrons = new Dictionary<Guid, string> { [b] = StepBCron },
            }, ct);

            // The read echoes the per-step cron, so what fires below is what was stored.
            using (var read = JsonDocument.Parse(await http.GetStringAsync($"/api/v1/workflows/{workflow}", ct)))
            {
                var crons = read.RootElement.GetProperty("entryCrons");
                Assert.Equal(StepBCron, crons.GetProperty(b.ToString("D")).GetString());
                Assert.False(crons.TryGetProperty(a.ToString("D"), out _), "step A inherits the workflow cron and has no entry of its own");
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

            Assert.True(perA is >= 1 and <= 3, $"step A (workflow cron {WorkflowCron}) fired {perA} times in {RunFor.TotalSeconds}s, expected 2±1: {summary}");
            Assert.True(perB is >= 5 and <= 7, $"step B (entry cron {StepBCron}) fired {perB} times in {RunFor.TotalSeconds}s, expected 6±1: {summary}");
            Assert.True(perB > perA, $"step B's faster cron did not fire more often than step A's: {summary}");

            // One fire is one correlation id: no two dispatches share one, which also proves A's and B's
            // fires at a shared second (:00, :30) are separate fires rather than one fire of both.
            var duplicate = dispatches.GroupBy(d => d.CorrelationId).FirstOrDefault(g => g.Count() > 1);
            Assert.True(duplicate is null, $"correlation id {duplicate?.Key} is on {duplicate?.Count()} dispatches: {summary}");

            Assert.True(after.Count == 0,
                $"{after.Count} dispatch(es) after the stop at {stopRequested:HH:mm:ss.fff} (+{StopSlack.TotalSeconds}s slack): {summary}");
        }
        finally
        {
            // Best effort, workflow first: the steps are referenced by it.
            if (workflow != Guid.Empty)
            {
                await TryAsync(() => http.PostAsJsonAsync("/api/v1/orchestration/stop", workflow));
                await TryAsync(() => http.DeleteAsync($"/api/v1/workflows/{workflow}"));
            }

            foreach (var id in new[] { a, b })
            {
                if (id != Guid.Empty)
                {
                    await TryAsync(() => http.DeleteAsync($"/api/v1/steps/{id}"));
                }
            }
        }
    }

    private sealed record Dispatch(DateTimeOffset At, Guid StepId, string CorrelationId);

    /// <summary>
    /// This workflow's entry dispatches in the window, read until two polls agree. Ingest runs
    /// seconds behind, so one immediate query would undercount the last fires before the stop.
    /// </summary>
    private static async Task<List<Dispatch>> SettledDispatchesAsync(
        Guid workflow, DateTimeOffset from, DateTimeOffset to, CancellationToken ct)
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

            if ((previous is not null && previous.Count == current.Count && current.Count > 0)
                || DateTime.UtcNow > deadline)
            {
                return current;
            }

            previous = current;
            await Task.Delay(TimeSpan.FromSeconds(5), ct);
        }
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

    private static async Task TryAsync(Func<Task<HttpResponseMessage>> call)
    {
        try
        {
            (await call()).Dispose();
        }
        catch (HttpRequestException)
        {
        }
    }
}
