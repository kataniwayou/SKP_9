using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Processor.Analyst.Panels;

/// <summary>
/// Executes a business-layer <see cref="PanelDefinition"/> against Elasticsearch and turns the
/// response into a <see cref="PanelReading"/> with its trust flags computed.
/// <para>
/// <b>The trust decision this class makes:</b> every panel query here is written against the SAME
/// broad scope -- every outcome record for the target workflow (<c>attributes.Result</c> present,
/// <c>attributes.WorkflowId</c> matching, emitter not the orchestrator) in the window -- and only
/// narrows to the panel's specific interest inside an aggregation. That is what lets
/// <c>hits.total.value</c> answer "did anything get reported at all" independently of whether the
/// panel's own slice of it happens to be zero:
/// </para>
/// <list type="bullet">
/// <item><description>
/// <c>hits.total.value == 0</c> -- no outcome record of any kind in the window. Indistinguishable
/// from a blind spot (nothing reported), so <c>SeriesPresent</c>, <c>WindowFullyCovered</c> and
/// <c>NoDataDistinguishable</c> are all <c>false</c> -- matching the same-panel convention
/// <c>FixturePanelReader.MissingSeries</c> already uses for an absent series.
/// </description></item>
/// <item><description>
/// <c>hits.total.value > 0</c> -- the pipeline is reporting outcomes in this window, so a
/// panel-specific bucket reading zero (no failures; a Cancelled bucket with no hits) is a genuine
/// zero, not a gap. <c>SeriesPresent</c> and <c>NoDataDistinguishable</c> are both <c>true</c>.
/// </description></item>
/// </list>
/// <para>
/// This is the case the brief calls out as "generally drawable" on Elasticsearch, unlike Prometheus
/// (see <see cref="PrometheusPanelSource"/>): a clean zero-count aggregation differs structurally
/// from an absent index or a query error, both of which are transport failures here and become
/// <see cref="PanelUnavailableException"/> rather than a poor-trust reading.
/// </para>
/// </summary>
internal sealed class ElasticPanelSource
{
    /// <summary>
    /// How far the earliest document in the window may sit after <c>range.From</c> and still count
    /// as the window being fully covered. Generous relative to ingest lag (memory: the live suite's
    /// two-minute window is already tight) -- this is asking "did the data stream actually reach
    /// back to the start of what was requested", not policing second-level precision.
    /// </summary>
    private static readonly TimeSpan CoverageTolerance = TimeSpan.FromMinutes(2);

    private readonly HttpClient _http;

    public ElasticPanelSource(HttpClient httpClient, IOptions<PanelSourceOptions> options)
    {
        ArgumentNullException.ThrowIfNull(httpClient);
        ArgumentNullException.ThrowIfNull(options);

        _http = httpClient;

        var baseUrl = options.Value.ElasticBaseUrl;
        if (!string.IsNullOrWhiteSpace(baseUrl))
        {
            try
            {
                _http.BaseAddress = new Uri(baseUrl, UriKind.Absolute);
            }
            catch (UriFormatException ex)
            {
                // F3: consistent with LivePanelReader.Find -- a configuration problem that means
                // this source cannot be used is the same domain failure as one it cannot reach, so
                // it is this same exception type rather than a raw framework one.
                throw new PanelUnavailableException(
                    "elasticsearch", $"Analyst:Panels:ElasticBaseUrl is malformed: {ex.Message}");
            }
        }
    }

    internal async Task<PanelReading> ReadAsync(
        PanelDefinition definition, Guid targetWorkflowId, TimeRange range, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(definition);

        var body = definition.Query
            .Replace("{{FROM}}", range.From.UtcDateTime.ToString("o"), StringComparison.Ordinal)
            .Replace("{{TO}}", range.To.UtcDateTime.ToString("o"), StringComparison.Ordinal)
            .Replace("{{WORKFLOW}}", targetWorkflowId.ToString("D"), StringComparison.Ordinal);

        using var request = new HttpRequestMessage(HttpMethod.Post, $"/{PanelRegistry.ElasticIndex}/_search")
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };

        HttpResponseMessage response;
        try
        {
            response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException ex)
        {
            // DNS, TCP, TLS, connection refused -- including the dead-port-forward case, where the
            // socket is bound but refuses the connection outright.
            throw new PanelUnavailableException(definition.PanelId, $"elasticsearch could not be reached: {ex.Message}");
        }
        catch (TaskCanceledException ex) when (!ct.IsCancellationRequested)
        {
            // The request's own timeout, not the caller's cancellation -- that case propagates
            // untouched so the loop's own cancellation handling still sees it as such.
            throw new PanelUnavailableException(definition.PanelId, $"elasticsearch timed out: {ex.Message}");
        }
        catch (InvalidOperationException ex)
        {
            // HttpClient throws this -- not HttpRequestException -- when it is handed a relative URI
            // and has no BaseAddress: a null or blank Analyst:Panels:ElasticBaseUrl. That is exactly
            // as much "the source could not be reached" as a refused connection, and must land in the
            // same domain channel rather than escaping the loop as a raw framework exception.
            throw new PanelUnavailableException(definition.PanelId, $"elasticsearch is not configured: {ex.Message}");
        }

        using (response)
        {
            var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

            if (!response.IsSuccessStatusCode)
            {
                throw new PanelUnavailableException(
                    definition.PanelId, $"elasticsearch returned {(int)response.StatusCode}: {Truncate(text)}");
            }

            return Parse(definition, range, text);
        }
    }

    /// <summary>
    /// The response-to-reading translation, split out from <see cref="ReadAsync"/> so
    /// <c>PanelTrustTests</c> can drive it directly from a committed fixture without any HTTP
    /// machinery in the way.
    /// </summary>
    internal static PanelReading Parse(PanelDefinition definition, TimeRange range, string responseJson)
    {
        ArgumentNullException.ThrowIfNull(definition);
        ArgumentNullException.ThrowIfNull(responseJson);

        using var doc = ParseJson(definition.PanelId, responseJson);
        var root = doc.RootElement;

        if (root.TryGetProperty("error", out var errorElement))
        {
            throw new PanelUnavailableException(
                definition.PanelId, $"elasticsearch reported an error: {Truncate(errorElement.ToString())}");
        }

        var timedOut = root.TryGetProperty("timed_out", out var timedOutElement) && timedOutElement.GetBoolean();
        var shardsFailed = root.TryGetProperty("_shards", out var shardsElement)
            && shardsElement.TryGetProperty("failed", out var failedElement)
            && failedElement.GetInt32() > 0;

        if (timedOut || shardsFailed)
        {
            // A degraded 200 -- partial shard failure or a timeout mid-aggregation. The counts in a
            // response like this cannot be told apart from an undercount, so this is a transport
            // failure, not a poor-trust reading.
            throw new PanelUnavailableException(
                definition.PanelId, "elasticsearch returned a partial or timed-out response");
        }

        long total;
        try
        {
            total = root.GetProperty("hits").GetProperty("total").GetProperty("value").GetInt64();
        }
        catch (KeyNotFoundException ex)
        {
            throw new PanelUnavailableException(definition.PanelId, $"unexpected elasticsearch response shape: {ex.Message}");
        }

        if (total == 0)
        {
            // Not one record in the window that this panel's scope admits -- indistinguishable from a
            // blind spot. Matches FixturePanelReader.MissingSeries: all three flags false together.
            //
            // Named per panel rather than shared, because the panels do not all count the same thing.
            // step-outcomes and step-failures scope to outcome records; refused-messages scopes to
            // every record for the workflow, since a refusal has no attributes.Result to require and
            // a scope narrowed to refusals could not tell an all-clear from an ingest outage. Calling
            // that 0 "outcome records" would be a small dishonesty the model has no way to check.
            return new PanelReading(
                definition.PanelId, definition.Layer,
                $"{{\"{ScopeCountName(definition.PanelId)}\":0}}", SampleCount: 0,
                new PanelTrust(SeriesPresent: false, WindowFullyCovered: false, NoDataDistinguishable: false));
        }

        var aggregations = root.GetProperty("aggregations");
        var windowFullyCovered = IsWindowFullyCovered(aggregations, range);

        return definition.PanelId switch
        {
            "step-outcomes" => BuildStepOutcomes(definition, total, aggregations, windowFullyCovered),
            "step-failures" => BuildStepFailures(definition, total, aggregations, windowFullyCovered),
            "refused-messages" => BuildRefusedMessages(definition, total, aggregations, windowFullyCovered),
            "run-boundaries" => BuildRunBoundaries(definition, total, aggregations, windowFullyCovered),
            _ => throw new PanelUnavailableException(
                definition.PanelId, $"no elasticsearch response parser registered for panel '{definition.PanelId}'"),
        };
    }

    private static bool IsWindowFullyCovered(JsonElement aggregations, TimeRange range)
    {
        if (!aggregations.TryGetProperty("earliest", out var earliest)
            || !earliest.TryGetProperty("value", out var earliestValue)
            || earliestValue.ValueKind != JsonValueKind.Number)
        {
            return false;
        }

        var earliestMs = earliestValue.GetDouble();
        var fromMs = range.From.ToUnixTimeMilliseconds();

        return earliestMs <= fromMs + CoverageTolerance.TotalMilliseconds;
    }

    private static PanelReading BuildStepOutcomes(
        PanelDefinition definition, long total, JsonElement aggregations, bool windowFullyCovered)
    {
        var buckets = aggregations.GetProperty("by_result").GetProperty("buckets");

        var completed = BucketCount(buckets, "Completed");
        var failed = BucketCount(buckets, "Failed");
        var cancelled = BucketCount(buckets, "Cancelled");

        var valueJson = JsonSerializer.Serialize(new
        {
            totalOutcomeRecords = total,
            completed,
            failed,
            cancelled,
        });

        return new PanelReading(
            definition.PanelId, definition.Layer, valueJson, SampleCount: checked((int)total),
            new PanelTrust(SeriesPresent: true, windowFullyCovered, NoDataDistinguishable: true));
    }

    private static PanelReading BuildStepFailures(
        PanelDefinition definition, long total, JsonElement aggregations, bool windowFullyCovered)
    {
        var failedAgg = aggregations.GetProperty("failed");
        var failedCount = failedAgg.GetProperty("doc_count").GetInt64();

        var samples = new List<JsonElement>();
        if (failedAgg.TryGetProperty("samples", out var samplesAgg)
            && samplesAgg.TryGetProperty("hits", out var hitsWrapper)
            && hitsWrapper.TryGetProperty("hits", out var hitsArray))
        {
            foreach (var hit in hitsArray.EnumerateArray())
            {
                if (hit.TryGetProperty("_source", out var source))
                {
                    samples.Add(source.Clone());
                }
            }
        }

        var valueJson = JsonSerializer.Serialize(new
        {
            totalOutcomeRecords = total,
            failedCount,
            samples,
        });

        // SampleCount is the total outcome-record count, matching BuildStepOutcomes -- not
        // failedCount. A healthy window with zero failures genuinely returned "total" records; using
        // failedCount here would record it in the trace as a panel that returned nothing.
        return new PanelReading(
            definition.PanelId, definition.Layer, valueJson, SampleCount: checked((int)total),
            new PanelTrust(SeriesPresent: true, windowFullyCovered, NoDataDistinguishable: true));
    }

    /// <summary>
    /// What <c>hits.total</c> counts for a given panel, as the name the model sees on a reading.
    /// <para>
    /// Every Elastic panel here queries a BROAD scope and narrows inside an aggregation -- that is
    /// what lets <c>hits.total</c> answer "was anything reported at all" independently of whether the
    /// panel's own slice is zero. But the broad scope is not the same scope for every panel, and the
    /// reading has to say which one it is.
    /// </para>
    /// </summary>
    private static string ScopeCountName(string panelId) => panelId switch
    {
        "refused-messages" => "totalWorkflowRecords",
        "run-boundaries" => "totalWorkflowRecords",
        _ => "totalOutcomeRecords",
    };

    /// <summary>
    /// The refusals reading: how much work this workflow lost in the window, split by queue and by
    /// whether the park actually landed, with the exceptions that caused the most recent five.
    /// <para>
    /// <b>The outcome split comes from a <c>filters</c> aggregation, not a <c>terms</c> one.</b> The
    /// two refusal templates share a long prefix and differ only past it, and the Kibana panel found
    /// the expensive way that a terms aggregation's bucket label gets truncated to that shared prefix
    /// -- collapsing the only distinction the split exists to make, silently and identically for both
    /// variants. A filters aggregation names its own buckets, so nothing can truncate them.
    /// </para>
    /// </summary>
    private static PanelReading BuildRefusedMessages(
        PanelDefinition definition, long total, JsonElement aggregations, bool windowFullyCovered)
    {
        var refusals = aggregations.GetProperty("refusals");
        var refusedCount = refusals.GetProperty("doc_count").GetInt64();

        var byQueue = new Dictionary<string, long>(StringComparer.Ordinal);
        if (refusals.TryGetProperty("by_queue", out var byQueueAgg)
            && byQueueAgg.TryGetProperty("buckets", out var queueBuckets))
        {
            foreach (var bucket in queueBuckets.EnumerateArray())
            {
                byQueue[bucket.GetProperty("key").GetString() ?? "(unnamed queue)"] =
                    bucket.GetProperty("doc_count").GetInt64();
            }
        }

        var outcomes = refusals.GetProperty("by_outcome").GetProperty("buckets");

        var samples = new List<JsonElement>();
        if (refusals.TryGetProperty("samples", out var samplesAgg)
            && samplesAgg.TryGetProperty("hits", out var hitsWrapper)
            && hitsWrapper.TryGetProperty("hits", out var hitsArray))
        {
            foreach (var hit in hitsArray.EnumerateArray())
            {
                if (hit.TryGetProperty("_source", out var source))
                {
                    samples.Add(source.Clone());
                }
            }
        }

        var valueJson = JsonSerializer.Serialize(new
        {
            totalWorkflowRecords = total,
            refusedCount,
            parked = BucketCount(outcomes, "parked"),
            notParked = BucketCount(outcomes, "notParked"),
            byQueue,
            samples,
        });

        // The scope total, matching both other Elastic panels -- NOT refusedCount. Four refusals out
        // of 612 records is not a panel that returned four things, and recording it that way would
        // put a healthy window in the trace as a panel that returned almost nothing.
        return new PanelReading(
            definition.PanelId, definition.Layer, valueJson, SampleCount: checked((int)total),
            new PanelTrust(SeriesPresent: true, windowFullyCovered, NoDataDistinguishable: true));
    }

    /// <summary>
    /// The run-boundary reading: how many runs this workflow began, how many branches ended, and the
    /// importer polls that explain a gap between them.
    /// <para>
    /// <b>drainedPolls is carried for the model's benefit, not the panel's.</b> An operator seeing
    /// entries with no terminals can go and read the importer's log; the agent has only what a
    /// reading contains, and "the source had nothing to read" and "work is being lost" produce the
    /// identical shape. Without this count the agent must call every idle window inconclusive.
    /// </para>
    /// </summary>
    private static PanelReading BuildRunBoundaries(
        PanelDefinition definition, long total, JsonElement aggregations, bool windowFullyCovered)
    {
        var positions = aggregations.GetProperty("boundaries").GetProperty("by_position")
            .GetProperty("buckets");
        var polls = aggregations.GetProperty("polls");

        var valueJson = JsonSerializer.Serialize(new
        {
            totalWorkflowRecords = total,
            entry = BucketCount(positions, "entry"),
            terminal = BucketCount(positions, "terminal"),
            importerPolls = polls.GetProperty("doc_count").GetInt64(),
            drainedPolls = polls.GetProperty("drained").GetProperty("doc_count").GetInt64(),
        });

        return new PanelReading(
            definition.PanelId, definition.Layer, valueJson, SampleCount: checked((int)total),
            new PanelTrust(SeriesPresent: true, windowFullyCovered, NoDataDistinguishable: true));
    }

    private static long BucketCount(JsonElement buckets, string name)
        => buckets.TryGetProperty(name, out var bucket) && bucket.TryGetProperty("doc_count", out var count)
            ? count.GetInt64()
            : 0;

    private static JsonDocument ParseJson(string panelId, string responseJson)
    {
        try
        {
            return JsonDocument.Parse(responseJson);
        }
        catch (JsonException ex)
        {
            throw new PanelUnavailableException(panelId, $"elasticsearch response could not be parsed: {ex.Message}");
        }
    }

    private static string Truncate(string text) => text.Length <= 500 ? text : string.Concat(text.AsSpan(0, 500), "...");
}
