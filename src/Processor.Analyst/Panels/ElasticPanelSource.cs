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
            _http.BaseAddress = new Uri(baseUrl, UriKind.Absolute);
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
            // No outcome record at all in the window -- indistinguishable from a blind spot.
            // Matches FixturePanelReader.MissingSeries: all three flags false together.
            return new PanelReading(
                definition.PanelId, definition.Layer, """{"totalOutcomeRecords":0}""", SampleCount: 0,
                new PanelTrust(SeriesPresent: false, WindowFullyCovered: false, NoDataDistinguishable: false));
        }

        var aggregations = root.GetProperty("aggregations");
        var windowFullyCovered = IsWindowFullyCovered(aggregations, range);

        return definition.PanelId switch
        {
            "step-outcomes" => BuildStepOutcomes(definition, total, aggregations, windowFullyCovered),
            "step-failures" => BuildStepFailures(definition, total, aggregations, windowFullyCovered),
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
