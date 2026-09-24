using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Processor.Analyst.Panels;

/// <summary>
/// Executes an ops-layer <see cref="PanelDefinition"/> against Prometheus's <c>query_range</c> and
/// turns the response into a <see cref="PanelReading"/> with its trust flags computed.
/// <para>
/// <b>Never an instant query, and never a legend sample.</b> A Grafana legend samples at
/// <c>now-15m</c>, which is why no chaos run can ever show a line stop through it -- this class
/// exists to read the actual range instead, and every panel in <see cref="PanelRegistry"/> already
/// says <c>[60s]</c> or <c>[40s]</c>, never a bare instant.
/// </para>
/// <para>
/// <b>The <c>NoDataDistinguishable</c> decision for this source, made explicitly and NOT silently
/// folded into <c>SeriesPresent</c>:</b> on this system, it cannot be independently computed, and
/// this class does not pretend otherwise.
/// </para>
/// <para>
/// A <c>rate()</c>/<c>sum(rate())</c> query over a counter or histogram that was scraped but never
/// incremented, and the identical query over a label combination that was NEVER OBSERVED AT ALL (the
/// metric endpoint is up, but no code path ever called <c>.Add()</c>/<c>.Record()</c> with those
/// exact label values), return the **same empty <c>result: []</c>**. OpenTelemetry/Prometheus client
/// libraries only materialise a time series once an observation with that label set actually occurs
/// -- confirmed for this codebase's own pipeline instruments (a constructor-time <c>Add(0)</c> seed
/// is dropped; see the "pushed metric seeds reach no reader" note) -- so "nothing happened" (a real
/// series, legitimately flat) and "nothing was ever reported for this label combination" (a blind
/// spot: a dead replica, a metrics regression, a processor that was never deployed) are structurally
/// indistinguishable from one <c>query_range</c> response. A companion <c>up{}</c> check would only
/// prove the SCRAPE TARGET is reachable, not that this specific series was ever recorded, so it does
/// not close the gap either.
/// </para>
/// <para>
/// The decision: <c>NoDataDistinguishable</c> tracks <c>SeriesPresent</c> exactly on this source --
/// <c>false</c> whenever the result is empty (or every returned point is a stale <c>NaN</c>), and
/// <c>true</c> whenever at least one real value came back, because a series that IS present is real,
/// scraped telemetry and its readings -- including a legitimate zero -- can be trusted. The flag adds
/// no information beyond <c>SeriesPresent</c> for Prometheus readings specifically; it still carries
/// its full, independent meaning for Elasticsearch readings (see <see cref="ElasticPanelSource"/>),
/// where a clean zero-bucket aggregation over documents that undeniably exist is a case Prometheus
/// cannot produce at all. An agent must be told this: a Prometheus panel's "no data" can never be
/// upgraded to "confirmed quiet" by this flag, only by corroborating evidence from another panel.
/// </para>
/// </summary>
internal sealed class PrometheusPanelSource
{
    /// <summary>Floor for query_range's step, matching the telemetry resolution floor (15s scrape).</summary>
    private static readonly TimeSpan MinStep = TimeSpan.FromSeconds(15);

    /// <summary>Caps the number of points a wide window returns; see <see cref="ComputeStep"/>.</summary>
    private const int MaxPointsPerSeries = 300;

    private readonly HttpClient _http;

    public PrometheusPanelSource(HttpClient httpClient, IOptions<PanelSourceOptions> options)
    {
        ArgumentNullException.ThrowIfNull(httpClient);
        ArgumentNullException.ThrowIfNull(options);

        _http = httpClient;

        var baseUrl = options.Value.PrometheusBaseUrl;
        if (!string.IsNullOrWhiteSpace(baseUrl))
        {
            _http.BaseAddress = new Uri(baseUrl, UriKind.Absolute);
        }
    }

    /// <param name="definition">The panel to read.</param>
    /// <param name="targetWorkflowId">
    /// Unused. <c>pipeline_*</c> series carry no workflow label and a replica ordinarily serves
    /// several workflows at once, so no Prometheus query in <see cref="PanelRegistry"/> can be scoped
    /// by it -- see <see cref="IPanelReader.ReadAsync"/>'s own doc comment. Accepted only so this
    /// source's signature matches <see cref="ElasticPanelSource.ReadAsync"/>, which
    /// <see cref="LivePanelReader"/> dispatches to uniformly.
    /// </param>
    /// <param name="range">The window to read.</param>
    /// <param name="ct">Cancellation.</param>
    internal async Task<PanelReading> ReadAsync(
        PanelDefinition definition, Guid targetWorkflowId, TimeRange range, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(definition);
        _ = targetWorkflowId;

        var step = ComputeStep(range);
        var url =
            "/api/v1/query_range" +
            $"?query={Uri.EscapeDataString(definition.Query)}" +
            $"&start={range.From.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture)}" +
            $"&end={range.To.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture)}" +
            $"&step={step.TotalSeconds.ToString(CultureInfo.InvariantCulture)}s";

        HttpResponseMessage response;
        try
        {
            response = await _http.GetAsync(url, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException ex)
        {
            // DNS, TCP, TLS, connection refused -- including the dead-port-forward case, where the
            // socket is bound but refuses the connection outright.
            throw new PanelUnavailableException(definition.PanelId, $"prometheus could not be reached: {ex.Message}");
        }
        catch (TaskCanceledException ex) when (!ct.IsCancellationRequested)
        {
            // The request's own timeout, not the caller's cancellation -- that case propagates
            // untouched so the loop's own cancellation handling still sees it as such.
            throw new PanelUnavailableException(definition.PanelId, $"prometheus timed out: {ex.Message}");
        }
        catch (InvalidOperationException ex)
        {
            // HttpClient throws this -- not HttpRequestException -- when it is handed a relative URI
            // and has no BaseAddress: a null or blank Analyst:Panels:PrometheusBaseUrl. That is
            // exactly as much "the source could not be reached" as a refused connection, and must
            // land in the same domain channel rather than escaping the loop as a raw framework
            // exception.
            throw new PanelUnavailableException(definition.PanelId, $"prometheus is not configured: {ex.Message}");
        }

        using (response)
        {
            var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

            // Prometheus answers a query error with 400/422/503 and a JSON body carrying "error" --
            // Parse below reads that body for either a non-success status or a 200 with
            // "status":"error" (which the API also returns for some partial-failure cases).
            if (!response.IsSuccessStatusCode)
            {
                throw new PanelUnavailableException(
                    definition.PanelId, $"prometheus returned {(int)response.StatusCode}: {Truncate(text)}");
            }

            return Parse(definition, range, step, text);
        }
    }

    /// <summary>
    /// The response-to-reading translation, split out from <see cref="ReadAsync"/> so
    /// <c>PanelTrustTests</c> can drive it directly from a committed fixture without any HTTP
    /// machinery in the way.
    /// </summary>
    internal static PanelReading Parse(PanelDefinition definition, TimeRange range, TimeSpan step, string responseJson)
    {
        ArgumentNullException.ThrowIfNull(definition);
        ArgumentNullException.ThrowIfNull(responseJson);

        using var doc = ParseJson(definition.PanelId, responseJson);
        var root = doc.RootElement;

        var status = root.TryGetProperty("status", out var statusElement) ? statusElement.GetString() : null;
        if (!string.Equals(status, "success", StringComparison.Ordinal))
        {
            var error = root.TryGetProperty("error", out var errorElement) ? errorElement.GetString() : "unknown error";
            throw new PanelUnavailableException(definition.PanelId, $"prometheus query failed: {error}");
        }

        if (!root.TryGetProperty("data", out var data) || !data.TryGetProperty("result", out var result))
        {
            throw new PanelUnavailableException(definition.PanelId, "unexpected prometheus response shape: no data.result");
        }

        var series = new List<(JsonElement Labels, List<(long TimestampSeconds, double Value)> Points)>();

        foreach (var seriesElement in result.EnumerateArray())
        {
            var labels = seriesElement.TryGetProperty("metric", out var metric) ? metric : default;
            var points = new List<(long, double)>();

            if (seriesElement.TryGetProperty("values", out var valuesElement))
            {
                foreach (var pair in valuesElement.EnumerateArray())
                {
                    var ts = pair[0].GetDouble();
                    var raw = pair[1].GetString();

                    // A staleness marker or an extrapolation gap comes back as the literal string
                    // "NaN". That step produced no real measurement -- it is dropped, not recorded
                    // as a zero, which would misreport an absence as a real reading.
                    if (raw is null || !double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
                        || double.IsNaN(value))
                    {
                        continue;
                    }

                    points.Add(((long)ts, value));
                }
            }

            series.Add((labels, points));
        }

        var totalPoints = series.Sum(s => s.Points.Count);

        if (totalPoints == 0)
        {
            // Empty result, or every point was NaN/stale. See this class's own doc comment: on
            // Prometheus this is indistinguishable from a genuinely quiet series, so
            // NoDataDistinguishable is false here exactly as it is for SeriesPresent -- matching
            // FixturePanelReader.MissingSeries's convention of all three flags false together.
            //
            // Same object shape as the populated case below -- {"seriesCount":0,"series":[]} rather
            // than a bare "[]" -- so the model parses one shape per panel instead of two, and the
            // empty case does not silently lose the seriesCount field it would otherwise carry.
            return new PanelReading(
                definition.PanelId, definition.Layer, """{"seriesCount":0,"series":[]}""", SampleCount: 0,
                new PanelTrust(SeriesPresent: false, WindowFullyCovered: false, NoDataDistinguishable: false));
        }

        var coverageThreshold = range.From.ToUnixTimeSeconds() + (long)Math.Ceiling(step.TotalSeconds);

        // Coverage is checked PER SERIES and ANDed, not from the single earliest point across every
        // series combined. The bug that shape had: four replicas covering the window from the start
        // made the fifth's late (or entirely absent-of-real-points) series invisible -- exactly the
        // orphaned-instrument case SeriesPresent/WindowFullyCovered exist to catch. A series with zero
        // real points fails this by construction (nothing to cover the window with).
        var windowFullyCovered = series.All(s =>
            s.Points.Count > 0 && s.Points.Min(p => p.TimestampSeconds) <= coverageThreshold);

        // seriesCount is surfaced alongside the readings so the model has something to compare
        // against its own expectations of how many replicas should be reporting -- this reader has no
        // independent source for "how many replicas exist" and cannot detect one that is missing from
        // the response entirely, only one that reported but did not cover the window.
        var seriesCount = series.Count(s => s.Points.Count > 0);

        var valueJson = JsonSerializer.Serialize(new
        {
            seriesCount,
            series = series.Select(s => new
            {
                labels = s.Labels.ValueKind == JsonValueKind.Object
                    ? s.Labels.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString())
                    : new Dictionary<string, string?>(),
                points = s.Points.Select(p => new
                {
                    timestamp = DateTimeOffset.FromUnixTimeSeconds(p.TimestampSeconds).ToString("O"),
                    value = p.Value,
                }),
            }),
        });

        return new PanelReading(
            definition.PanelId, definition.Layer, valueJson, SampleCount: totalPoints,
            // NoDataDistinguishable == SeriesPresent, by the decision documented on this class.
            new PanelTrust(SeriesPresent: true, windowFullyCovered, NoDataDistinguishable: true));
    }

    /// <summary>
    /// A step no finer than the telemetry resolution floor, no coarser than what keeps a wide window
    /// under <see cref="MaxPointsPerSeries"/> points -- wide enough to see a six-hour drift, without
    /// asking Prometheus for tens of thousands of points a monitoring window has no use for.
    /// </summary>
    internal static TimeSpan ComputeStep(TimeRange range)
    {
        var duration = range.To - range.From;
        if (duration <= TimeSpan.Zero)
        {
            return MinStep;
        }

        var evenStep = TimeSpan.FromSeconds(Math.Ceiling(duration.TotalSeconds / MaxPointsPerSeries));
        return evenStep > MinStep ? evenStep : MinStep;
    }

    private static JsonDocument ParseJson(string panelId, string responseJson)
    {
        try
        {
            return JsonDocument.Parse(responseJson);
        }
        catch (JsonException ex)
        {
            throw new PanelUnavailableException(panelId, $"prometheus response could not be parsed: {ex.Message}");
        }
    }

    private static string Truncate(string text) => text.Length <= 500 ? text : string.Concat(text.AsSpan(0, 500), "...");
}
