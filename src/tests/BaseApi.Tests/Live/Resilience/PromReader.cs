using System.Globalization;
using System.Text.Json;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// Reads the pipeline instruments, for the report only. No verdict depends on this.
/// <para>
/// <b>These are exported names, and they are not the instrument names.</b> Every gauge declares unit
/// "1", for which the OpenTelemetry Prometheus exporter appends _ratio — the code creates
/// pipeline.gate.open and Prometheus serves pipeline_gate_open_ratio. The names below were read back
/// from the live server rather than derived; an earlier draft elsewhere in this repo queried the
/// unsuffixed forms and would have matched nothing.
/// </para>
/// <para>
/// <b>A counter with no observations is absent, not zero.</b> pipeline_gate_trips_total has no series
/// until the gate first trips, so its appearance is itself the evidence. Every query returns a
/// nullable and a missing series is reported as "no series", never as an error or a zero.
/// </para>
/// </summary>
internal sealed class PromReader
{
    private static readonly IReadOnlyDictionary<string, string> Corroboration =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["gate trips"] = "sum(pipeline_gate_trips_total)",
            ["gate open"] = "min(pipeline_gate_open_ratio)",
            ["channel resets"] = "sum(pipeline_consumer_channel_resets_total)",
            ["consumers consuming"] = "min(pipeline_consumer_consuming_ratio)",
            ["transient sends"] = "sum(pipeline_messages_produced_total{outcome=\"transient\"})",
            ["requeued or parked"] =
                "sum(pipeline_messages_consumed_total{disposition=~\"requeued|parked\"})",
            ["inflight"] = "sum(pipeline_consumer_inflight)",
        };

    private readonly HttpClient _http;

    public PromReader(HttpClient http) => _http = http ?? throw new ArgumentNullException(nameof(http));

    /// <summary>The current value of an instant query, or null when the series does not exist.</summary>
    public async Task<double?> InstantAsync(string query, CancellationToken ct)
    {
        // Uri.EscapeDataString rather than HttpUtility.UrlEncode: the latter lives in a separate
        // assembly this test project has no reason to take a dependency on, and the queries below
        // carry braces, quotes and regex pipes that must survive intact.
        var url = $"{Chaos.PrometheusUrl.TrimEnd('/')}/api/v1/query?query={Uri.EscapeDataString(query)}";

        using var response = await _http.GetAsync(url, ct);
        if (!response.IsSuccessStatusCode)
        {
            return null;
        }

        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        var result = document.RootElement.GetProperty("data").GetProperty("result");

        if (result.GetArrayLength() == 0)
        {
            return null;
        }

        var raw = result[0].GetProperty("value")[1].GetString();

        // CultureInfo.InvariantCulture, not the current culture: Prometheus always renders values
        // with "." as the decimal separator. On a comma-decimal culture, a current-culture parse
        // would fail on a genuinely present value like "1.5" and collapse it to null -- indistinguishable
        // from a missing series. That inversion matters most for pipeline_gate_trips_total, where
        // "absent" is itself the evidence the gate never tripped; misreporting a present value as
        // absent would silently erase that evidence.
        return double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
            ? value
            : null;
    }

    /// <summary>Every corroborating series, for printing beside a verdict.</summary>
    public async Task<IReadOnlyDictionary<string, double?>> CorroborationAsync(CancellationToken ct)
    {
        var readings = new Dictionary<string, double?>(StringComparer.Ordinal);

        foreach (var (label, query) in Corroboration)
        {
            readings[label] = await InstantAsync(query, ct);
        }

        return readings;
    }
}
