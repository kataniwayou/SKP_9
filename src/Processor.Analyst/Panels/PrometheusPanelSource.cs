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

    internal async Task<PanelReading> ReadAsync(PanelDefinition definition, TimeRange range, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(definition);

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
            return new PanelReading(
                definition.PanelId, definition.Layer, "[]", SampleCount: 0,
                new PanelTrust(SeriesPresent: false, WindowFullyCovered: false, NoDataDistinguishable: false));
        }

        var earliestSeconds = series.SelectMany(s => s.Points).Min(p => p.TimestampSeconds);
        var windowFullyCovered = earliestSeconds <= range.From.ToUnixTimeSeconds() + (long)Math.Ceiling(step.TotalSeconds);

        var valueJson = JsonSerializer.Serialize(series.Select(s => new
        {
            labels = s.Labels.ValueKind == JsonValueKind.Object
                ? s.Labels.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString())
                : new Dictionary<string, string?>(),
            points = s.Points.Select(p => new
            {
                timestamp = DateTimeOffset.FromUnixTimeSeconds(p.TimestampSeconds).ToString("O"),
                value = p.Value,
            }),
        }));

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
