using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Processor.Analyst.Panels;
using Xunit;

namespace BaseApi.Tests.Analyst;

/// <summary>
/// Trust computation, driven entirely from recorded Elasticsearch and Prometheus response payloads
/// committed under <c>Fixtures/</c>. No test here contacts a live system: every fixture is a
/// hand-built shape matching what those APIs actually return for the case its filename names, and
/// every assertion goes through <see cref="ElasticPanelSource.Parse"/> or
/// <see cref="PrometheusPanelSource.Parse"/> directly, or through <c>ReadAsync</c> against a fake
/// <see cref="HttpMessageHandler"/> that serves one of those same fixtures.
/// <para>
/// <b>The whole point, per panel:</b> "nothing happened" and "nothing reported" must never produce
/// the same <see cref="PanelTrust"/> on Elasticsearch, and <see cref="PanelTrust.NoDataDistinguishable"/>
/// must be an honest, DOCUMENTED no-op on Prometheus rather than a silent copy of
/// <see cref="PanelTrust.SeriesPresent"/> -- see the decision recorded on
/// <see cref="PrometheusPanelSource"/>'s own doc comment, and Task 14's report.
/// </para>
/// </summary>
public sealed class PanelTrustTests
{
    private static readonly TimeRange Window = new(
        DateTimeOffset.FromUnixTimeSeconds(1790208000), // 2026-09-24T00:00:00Z
        DateTimeOffset.FromUnixTimeSeconds(1790229600)); // 2026-09-24T06:00:00Z

    private static PanelDefinition Def(string panelId) => PanelRegistry.All.Single(p => p.PanelId == panelId);

    private static string Fixture(string name)
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Analyst", "Fixtures", name));

    // ---------------------------------------------------------------------------------------
    // Prometheus
    // ---------------------------------------------------------------------------------------

    [Fact]
    public void Prometheus_EmptyResult_IsAbsentAndNoDataIsNotDistinguishable()
    {
        var step = PrometheusPanelSource.ComputeStep(Window);

        var reading = PrometheusPanelSource.Parse(
            Def("queue-wait"), Window, step, Fixture("prometheus-empty-result.json"));

        Assert.False(reading.Trust.SeriesPresent);
        Assert.False(reading.Trust.WindowFullyCovered);
        Assert.False(reading.Trust.NoDataDistinguishable);
        Assert.Equal(0, reading.SampleCount);
    }

    [Fact]
    public void Prometheus_FirstSampleIsLaterThanRangeFrom_WindowIsNotFullyCovered()
    {
        var step = PrometheusPanelSource.ComputeStep(Window);

        var reading = PrometheusPanelSource.Parse(
            Def("queue-wait"), Window, step, Fixture("prometheus-present-partial-window.json"));

        // The series is real -- a replica that only started an hour into the window -- so it must
        // still be trusted for what it does cover. It just does not cover the whole window.
        Assert.True(reading.Trust.SeriesPresent);
        Assert.False(reading.Trust.WindowFullyCovered);
    }

    [Fact]
    public void Prometheus_SeriesPresentAndCoveringTheWindow_IsFullyTrusted()
    {
        var step = PrometheusPanelSource.ComputeStep(Window);

        var reading = PrometheusPanelSource.Parse(
            Def("queue-wait"), Window, step, Fixture("prometheus-present-covering.json"));

        Assert.True(reading.Trust.SeriesPresent);
        Assert.True(reading.Trust.WindowFullyCovered);
        // The documented decision for this source: a present series is real, scraped telemetry, so
        // NoDataDistinguishable tracks SeriesPresent here -- it is not an independent signal on
        // Prometheus the way it is on Elasticsearch (see the Elastic_* tests below).
        Assert.True(reading.Trust.NoDataDistinguishable);
        Assert.Equal(3, reading.SampleCount);
    }

    [Fact]
    public void Prometheus_EveryPointIsStale_IsTreatedTheSameAsAnEmptyResult()
    {
        // A series that exists in the response but whose every value is the literal string "NaN" --
        // a staleness marker -- carries no real measurement. Counting it as SeriesPresent would trust
        // a reading that is not there.
        var step = PrometheusPanelSource.ComputeStep(Window);

        var reading = PrometheusPanelSource.Parse(
            Def("queue-wait"), Window, step, Fixture("prometheus-all-nan.json"));

        Assert.False(reading.Trust.SeriesPresent);
        Assert.False(reading.Trust.NoDataDistinguishable);
        Assert.Equal(0, reading.SampleCount);
    }

    [Fact]
    public void Prometheus_ErrorResponse_ThrowsPanelUnavailableRatherThanReturningAPoorReading()
    {
        var step = PrometheusPanelSource.ComputeStep(Window);

        var ex = Assert.Throws<PanelUnavailableException>(() =>
            PrometheusPanelSource.Parse(Def("queue-wait"), Window, step, Fixture("prometheus-error.json")));

        Assert.Contains("prometheus", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    // ---------------------------------------------------------------------------------------
    // Elasticsearch
    // ---------------------------------------------------------------------------------------

    [Fact]
    public void Elastic_ZeroBucketsOverAWindowWhereDocumentsExist_IsGenuinelyNothingHappened()
    {
        // 45 outcome records exist in the window; none of them is a failure. That is a real zero,
        // not a gap -- the pipeline is reporting, and it is reporting no failures.
        var reading = ElasticPanelSource.Parse(
            Def("step-outcomes"), Window, Fixture("elastic-outcomes-zero-failed-bucket.json"));

        Assert.True(reading.Trust.SeriesPresent);
        Assert.True(reading.Trust.NoDataDistinguishable);
        Assert.True(reading.Trust.WindowFullyCovered);

        using var value = JsonDocument.Parse(reading.ValueJson);
        Assert.Equal(0, value.RootElement.GetProperty("failed").GetInt64());
        Assert.Equal(45, value.RootElement.GetProperty("completed").GetInt64());
    }

    [Fact]
    public void Elastic_ZeroDocumentsAtAllInTheWindow_IsIndistinguishableFromNothingReported()
    {
        // The atom the whole distinction rests on: NOT ONE outcome record exists, of any kind. That
        // could mean the workflow was quiet, or that nothing is reporting at all -- and this response
        // alone cannot tell those apart, so every trust flag must say so.
        var reading = ElasticPanelSource.Parse(
            Def("step-outcomes"), Window, Fixture("elastic-outcomes-zero-documents.json"));

        Assert.False(reading.Trust.SeriesPresent);
        Assert.False(reading.Trust.WindowFullyCovered);
        Assert.False(reading.Trust.NoDataDistinguishable);
        Assert.Equal(0, reading.SampleCount);
    }

    [Fact]
    public void Elastic_HealthyOutcomes_ReportsAllThreeBucketsAndTheirTotal()
    {
        var reading = ElasticPanelSource.Parse(
            Def("step-outcomes"), Window, Fixture("elastic-outcomes-healthy.json"));

        Assert.Equal(120, reading.SampleCount);
        Assert.True(reading.Trust.SeriesPresent);
        Assert.True(reading.Trust.WindowFullyCovered);

        using var value = JsonDocument.Parse(reading.ValueJson);
        Assert.Equal(100, value.RootElement.GetProperty("completed").GetInt64());
        Assert.Equal(15, value.RootElement.GetProperty("failed").GetInt64());
        Assert.Equal(5, value.RootElement.GetProperty("cancelled").GetInt64());
    }

    [Fact]
    public void Elastic_EarliestDocumentIsWellAfterRangeFrom_WindowIsNotFullyCovered()
    {
        var reading = ElasticPanelSource.Parse(
            Def("step-outcomes"), Window, Fixture("elastic-outcomes-window-not-covered.json"));

        Assert.True(reading.Trust.SeriesPresent);
        Assert.False(reading.Trust.WindowFullyCovered);
    }

    [Fact]
    public void Elastic_StepFailures_ReturnsSampleRecordsAlongsideTheCount()
    {
        var reading = ElasticPanelSource.Parse(
            Def("step-failures"), Window, Fixture("elastic-failures-with-samples.json"));

        Assert.Equal(3, reading.SampleCount);
        Assert.True(reading.Trust.NoDataDistinguishable);
        Assert.Contains("downstream 503", reading.ValueJson, StringComparison.Ordinal);
        Assert.Contains("ProcessDispatchHandler", reading.ValueJson, StringComparison.Ordinal);
    }

    [Fact]
    public void Elastic_StepFailures_ZeroFailuresWithOutcomesPresentIsATrustedZero()
    {
        // 90 outcome records exist; none of them failed. Same shape as the outcomes-bucket case
        // above, for the panel that reports failure records specifically.
        var reading = ElasticPanelSource.Parse(
            Def("step-failures"), Window, Fixture("elastic-failures-zero.json"));

        Assert.Equal(0, reading.SampleCount);
        Assert.True(reading.Trust.SeriesPresent);
        Assert.True(reading.Trust.NoDataDistinguishable);
    }

    [Fact]
    public void Elastic_PartialShardFailure_ThrowsPanelUnavailableRatherThanReturningAnUndercount()
    {
        var ex = Assert.Throws<PanelUnavailableException>(() =>
            ElasticPanelSource.Parse(Def("step-outcomes"), Window, Fixture("elastic-partial-shard-failure.json")));

        Assert.Contains("elasticsearch", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    // ---------------------------------------------------------------------------------------
    // HTTP plumbing: query shape and transport-failure translation, via a fake handler.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public async Task ElasticPanelSource_PostsToTheOutcomeIndexWithTheRangeSubstituted()
    {
        var handler = new RecordingHandler(HttpStatusCode.OK, Fixture("elastic-outcomes-healthy.json"));
        var source = new ElasticPanelSource(
            new HttpClient(handler, disposeHandler: false),
            Options.Create(new PanelSourceOptions { ElasticBaseUrl = "http://elasticsearch:9200" }));

        await source.ReadAsync(Def("step-outcomes"), Window, CancellationToken.None);

        Assert.Equal(HttpMethod.Post, handler.LastMethod);
        Assert.EndsWith($"/{PanelRegistry.ElasticIndex}/_search", handler.LastPath, StringComparison.Ordinal);
        Assert.Contains("2026-09-24T00:00:00", handler.LastBody, StringComparison.Ordinal);
        Assert.Contains("2026-09-24T06:00:00", handler.LastBody, StringComparison.Ordinal);
        Assert.DoesNotContain("{{FROM}}", handler.LastBody, StringComparison.Ordinal);
        Assert.DoesNotContain("{{TO}}", handler.LastBody, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ElasticPanelSource_TranslatesAnHttpLevelErrorIntoPanelUnavailable()
    {
        var handler = new RecordingHandler(HttpStatusCode.NotFound, Fixture("elastic-index-not-found.json"));
        var source = new ElasticPanelSource(
            new HttpClient(handler, disposeHandler: false),
            Options.Create(new PanelSourceOptions { ElasticBaseUrl = "http://elasticsearch:9200" }));

        var ex = await Assert.ThrowsAsync<PanelUnavailableException>(
            () => source.ReadAsync(Def("step-outcomes"), Window, CancellationToken.None));

        Assert.Contains("elasticsearch", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task PrometheusPanelSource_UsesQueryRangeNeverAnInstantQuery()
    {
        var handler = new RecordingHandler(HttpStatusCode.OK, Fixture("prometheus-present-covering.json"));
        var source = new PrometheusPanelSource(
            new HttpClient(handler, disposeHandler: false),
            Options.Create(new PanelSourceOptions { PrometheusBaseUrl = "http://prometheus:9090" }));

        await source.ReadAsync(Def("queue-wait"), Window, CancellationToken.None);

        Assert.Equal(HttpMethod.Get, handler.LastMethod);
        Assert.Contains("/api/v1/query_range?", handler.LastPath, StringComparison.Ordinal);
        Assert.DoesNotContain("/api/v1/query?", handler.LastPath, StringComparison.Ordinal);
        // Grouped by the replica label (service_instance_id), never the scrape-target label.
        Assert.Contains("service_instance_id", handler.LastPath, StringComparison.Ordinal);
        Assert.Contains("&start=", handler.LastPath, StringComparison.Ordinal);
        Assert.Contains("&end=", handler.LastPath, StringComparison.Ordinal);
        Assert.Contains("&step=", handler.LastPath, StringComparison.Ordinal);
    }

    [Fact]
    public async Task PrometheusPanelSource_TranslatesAnHttpLevelErrorIntoPanelUnavailable()
    {
        var handler = new RecordingHandler(HttpStatusCode.ServiceUnavailable, Fixture("prometheus-error.json"));
        var source = new PrometheusPanelSource(
            new HttpClient(handler, disposeHandler: false),
            Options.Create(new PanelSourceOptions { PrometheusBaseUrl = "http://prometheus:9090" }));

        var ex = await Assert.ThrowsAsync<PanelUnavailableException>(
            () => source.ReadAsync(Def("queue-wait"), Window, CancellationToken.None));

        Assert.Contains("prometheus", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    // ---------------------------------------------------------------------------------------
    // LivePanelReader: dispatch by PanelKind.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public async Task LivePanelReader_DispatchesEachPanelToItsOwnSource()
    {
        var elasticHandler = new RecordingHandler(HttpStatusCode.OK, Fixture("elastic-outcomes-healthy.json"));
        var prometheusHandler = new RecordingHandler(HttpStatusCode.OK, Fixture("prometheus-present-covering.json"));
        var reader = BuildReader(elasticHandler, prometheusHandler);

        var businessReading = await reader.ReadAsync("step-outcomes", Window, CancellationToken.None);
        var opsReading = await reader.ReadAsync("queue-wait", Window, CancellationToken.None);

        Assert.Equal("business", businessReading.Layer);
        Assert.Equal("ops", opsReading.Layer);
        Assert.NotNull(elasticHandler.LastMethod);
        Assert.NotNull(prometheusHandler.LastMethod);
    }

    [Fact]
    public void LivePanelReader_DescribeReturnsTheRegistrysDescription()
    {
        var reader = BuildReader(
            new RecordingHandler(HttpStatusCode.OK, "{}"), new RecordingHandler(HttpStatusCode.OK, "{}"));

        var descriptor = reader.Describe("processor-liveness");

        Assert.Equal("ops", descriptor.Layer);
        Assert.True(descriptor.Description.Length >= 20);
    }

    [Fact]
    public void LivePanelReader_AnUnregisteredPanelIdThrows()
    {
        var reader = BuildReader(
            new RecordingHandler(HttpStatusCode.OK, "{}"), new RecordingHandler(HttpStatusCode.OK, "{}"));

        Assert.Throws<ArgumentException>(() => reader.Describe("does-not-exist"));
    }

    private static LivePanelReader BuildReader(RecordingHandler elasticHandler, RecordingHandler prometheusHandler)
    {
        var elastic = new ElasticPanelSource(
            new HttpClient(elasticHandler, disposeHandler: false),
            Options.Create(new PanelSourceOptions { ElasticBaseUrl = "http://elasticsearch:9200" }));
        var prometheus = new PrometheusPanelSource(
            new HttpClient(prometheusHandler, disposeHandler: false),
            Options.Create(new PanelSourceOptions { PrometheusBaseUrl = "http://prometheus:9090" }));

        return new LivePanelReader(elastic, prometheus);
    }

    /// <summary>Answers every request with one fixed status and body, and records the last request made.</summary>
    private sealed class RecordingHandler(HttpStatusCode status, string body) : HttpMessageHandler
    {
        internal HttpMethod? LastMethod { get; private set; }

        internal string LastPath { get; private set; } = string.Empty;

        internal string LastBody { get; private set; } = string.Empty;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            LastMethod = request.Method;
            LastPath = request.RequestUri?.PathAndQuery ?? string.Empty;
            LastBody = request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(ct);

            return new HttpResponseMessage(status)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            };
        }
    }
}
