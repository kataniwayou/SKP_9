using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.Options;
using BaseApi.Tests.Analyst;
using Processor.Analyst.Graph;
using Processor.Analyst.Panels;
using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// Records a live window's panel readings as replay fixtures, through the Analyst's own
/// <see cref="LivePanelReader"/> — the same queries, the same trust computation, the same value shapes
/// the model receives in production. Hand-built fixtures drift from those shapes silently; captured
/// ones cannot, at the moment they are taken.
/// <para>
/// <b>A capture is only worth committing with its answer key.</b> The window's true contents must be
/// known independently of the panels — what a feed simulator seeded, read off the importer's intake and
/// the outcome records themselves — or a replay against it measures agreement with the panels, not
/// accuracy. Record that key in the capture's <c>window.json</c> by hand.
/// </para>
/// <para>
/// Writes into the SOURCE tree, under <c>Analyst/Fixtures/replay/{name}</c>, so the capture is committed
/// and every later replay reads the same bytes. Needs the dev forwards (Elasticsearch on 19200,
/// Prometheus on 19090) and data still inside their retention.
/// </para>
/// </summary>
public sealed class AnalystReplayCapture
{
    [Fact]
    public async Task CaptureAWindow()
    {
        Assert.SkipUnless(
            Environment.GetEnvironmentVariable("SKP_ANALYST_CAPTURE") == "1",
            "set SKP_ANALYST_CAPTURE=1 (and SKP_CAPTURE_NAME/FROM/TO/WORKFLOW) to record a live window's "
            + "panel readings as replay fixtures; it writes into the source tree");

        string Env(string key, string fallback) => Environment.GetEnvironmentVariable(key) ?? fallback;

        var name = Env("SKP_CAPTURE_NAME", "busy-mixed-feed");
        var workflow = Guid.Parse(Env("SKP_CAPTURE_WORKFLOW", "1a56b3ca-e276-4815-87fa-5c2f48ab6dad"));
        var range = new TimeRange(
            DateTimeOffset.Parse(Env("SKP_CAPTURE_FROM", "2026-10-01T19:08:00.0199331Z"), CultureInfo.InvariantCulture),
            DateTimeOffset.Parse(Env("SKP_CAPTURE_TO", "2026-10-01T19:23:00.0199331Z"), CultureInfo.InvariantCulture));

        var options = Options.Create(new PanelSourceOptions
        {
            ElasticBaseUrl = Env("SKP_CAPTURE_ELASTIC", "http://localhost:19200"),
            PrometheusBaseUrl = Env("SKP_CAPTURE_PROMETHEUS", "http://localhost:19090"),
        });

        using var elasticHttp = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        using var prometheusHttp = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        var reader = new LivePanelReader(
            new ElasticPanelSource(elasticHttp, options), new PrometheusPanelSource(prometheusHttp, options));

        var dir = Path.Combine(ReplayFixtures.SourceRoot(), name);
        Directory.CreateDirectory(dir);

        foreach (var panel in PanelRegistry.All)
        {
            var reading = await reader.ReadAsync(panel.PanelId, workflow, range, history: false, TestContext.Current.CancellationToken);
            await File.WriteAllTextAsync(
                Path.Combine(dir, panel.PanelId + ".json"),
                JsonSerializer.Serialize(reading, ReplayFixtures.Json), TestContext.Current.CancellationToken);
        }

        // failure-causes is in PanelRegistry.All, so the loop above has already saved it as
        // failure-causes.json beside the other panels; a replay of the operator role needs it, so fail
        // loudly rather than commit a capture without it.
        Assert.True(File.Exists(Path.Combine(dir, "failure-causes.json")), "the capture must include failure-causes.json");

        // The run context the model is handed in its first message, read as of the window's end -- the
        // start/stop records and deploy markers decide how far back history may be read, so a replay
        // without it answers a different question than production asked.
        using var runHttp = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(30),
            BaseAddress = new Uri(options.Value.ElasticBaseUrl!),
        };
        var runContext = await new ElasticRunContextSource(runHttp).ReadAsync(workflow, range.To, TestContext.Current.CancellationToken);
        await File.WriteAllTextAsync(
            Path.Combine(dir, "run-context.json"),
            JsonSerializer.Serialize(runContext, ReplayFixtures.Json), TestContext.Current.CancellationToken);

        var window = Path.Combine(dir, "window.json");

        if (!File.Exists(window))
        {
            // The answer key is written by hand afterwards; never overwrite one already there.
            await File.WriteAllTextAsync(window, JsonSerializer.Serialize(new ReplayWindow(
                workflow, range.From, range.To, AnswerKey: "TODO: what this window truly contains"),
                ReplayFixtures.Json), TestContext.Current.CancellationToken);
        }
    }
}
