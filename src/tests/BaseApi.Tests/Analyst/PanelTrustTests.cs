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

    private static readonly Guid TargetWorkflowId = Guid.Parse("1a56b3ca-2222-4f0a-9c2a-000000000002");

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

        // Same object shape as a populated reading -- {"seriesCount":0,"series":[]} -- not a bare
        // "[]", so the model parses one shape per panel rather than two and the empty case does not
        // silently lose the seriesCount field it would otherwise carry.
        using var value = JsonDocument.Parse(reading.ValueJson);
        Assert.Equal(0, value.RootElement.GetProperty("seriesCount").GetInt32());
        Assert.Equal(0, value.RootElement.GetProperty("series").GetArrayLength());
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

        using var value = JsonDocument.Parse(reading.ValueJson);
        Assert.Equal(1, value.RootElement.GetProperty("seriesCount").GetInt32());
    }

    [Fact]
    public void Prometheus_OneSeriesCoversAndAnotherStartsLate_WindowIsNotFullyCovered()
    {
        // I3: the earlier implementation took the single earliest point across every series COMBINED,
        // so one replica covering from the start of the window masked a second replica that only
        // starts an hour in. Coverage must be checked per series and ANDed.
        var step = PrometheusPanelSource.ComputeStep(Window);

        var reading = PrometheusPanelSource.Parse(
            Def("queue-wait"), Window, step, Fixture("prometheus-mixed-coverage.json"));

        Assert.True(reading.Trust.SeriesPresent);
        Assert.False(reading.Trust.WindowFullyCovered);

        using var value = JsonDocument.Parse(reading.ValueJson);
        Assert.Equal(2, value.RootElement.GetProperty("seriesCount").GetInt32());
    }

    [Fact]
    public void Prometheus_OneSeriesReportsAndAnotherIsEntirelyStale_WindowIsNotFullyCoveredAndSeriesCountExcludesIt()
    {
        // The orphaned-instrument case named directly: a second replica technically appears in the
        // response but contributes not one real point (every value is a stale "NaN"). Reading
        // SeriesPresent from "any point across any series" alone would call this healthy; the fix
        // both fails WindowFullyCovered for it and excludes it from seriesCount, so the model can see
        // one replica reported, not two.
        var step = PrometheusPanelSource.ComputeStep(Window);

        var reading = PrometheusPanelSource.Parse(
            Def("queue-wait"), Window, step, Fixture("prometheus-partial-series-silent.json"));

        Assert.True(reading.Trust.SeriesPresent);
        Assert.False(reading.Trust.WindowFullyCovered);
        Assert.Equal(2, reading.SampleCount); // the two real points from the one reporting series

        using var value = JsonDocument.Parse(reading.ValueJson);
        Assert.Equal(1, value.RootElement.GetProperty("seriesCount").GetInt32());
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

        // SampleCount is the total outcome-record count (80), matching step-outcomes's convention --
        // NOT the failure count (3). A healthy window genuinely returned 80 records; recording 3
        // here would make a mostly-healthy window look like a panel that returned almost nothing.
        Assert.Equal(80, reading.SampleCount);
        Assert.True(reading.Trust.NoDataDistinguishable);
        Assert.Contains("downstream 503", reading.ValueJson, StringComparison.Ordinal);
        Assert.Contains("ProcessDispatchHandler", reading.ValueJson, StringComparison.Ordinal);
        Assert.Contains("\"failedCount\":3", reading.ValueJson, StringComparison.Ordinal);
    }

    [Fact]
    public void Elastic_StepFailures_ZeroFailuresWithOutcomesPresentIsATrustedZero()
    {
        // 90 outcome records exist; none of them failed. Same shape as the outcomes-bucket case
        // above, for the panel that reports failure records specifically.
        var reading = ElasticPanelSource.Parse(
            Def("step-failures"), Window, Fixture("elastic-failures-zero.json"));

        // Total (90), not the failure count (0) -- see the comment on the test above.
        Assert.Equal(90, reading.SampleCount);
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
    public async Task ElasticPanelSource_PostsToTheOutcomeIndexWithTheRangeAndWorkflowSubstituted()
    {
        var handler = new RecordingHandler(HttpStatusCode.OK, Fixture("elastic-outcomes-healthy.json"));
        var source = new ElasticPanelSource(
            new HttpClient(handler, disposeHandler: false),
            Options.Create(new PanelSourceOptions { ElasticBaseUrl = "http://elasticsearch:9200" }));

        await source.ReadAsync(Def("step-outcomes"), TargetWorkflowId, Window, CancellationToken.None);

        Assert.Equal(HttpMethod.Post, handler.LastMethod);
        Assert.EndsWith($"/{PanelRegistry.ElasticIndex}/_search", handler.LastPath, StringComparison.Ordinal);
        Assert.Contains("2026-09-24T00:00:00", handler.LastBody, StringComparison.Ordinal);
        Assert.Contains("2026-09-24T06:00:00", handler.LastBody, StringComparison.Ordinal);
        // C1: the target workflow id is in the request body, "D"-formatted (matching
        // ElasticLogReader.ReadRunRecordsAsync's own Term("attributes.WorkflowId", id.ToString("D"))),
        // and no template placeholder survives the substitution.
        Assert.Contains(TargetWorkflowId.ToString("D"), handler.LastBody, StringComparison.Ordinal);
        Assert.DoesNotContain("{{FROM}}", handler.LastBody, StringComparison.Ordinal);
        Assert.DoesNotContain("{{TO}}", handler.LastBody, StringComparison.Ordinal);
        Assert.DoesNotContain("{{WORKFLOW}}", handler.LastBody, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ElasticPanelSource_StepFailuresAlsoSubstitutesTheWorkflowId()
    {
        var handler = new RecordingHandler(HttpStatusCode.OK, Fixture("elastic-failures-zero.json"));
        var source = new ElasticPanelSource(
            new HttpClient(handler, disposeHandler: false),
            Options.Create(new PanelSourceOptions { ElasticBaseUrl = "http://elasticsearch:9200" }));

        await source.ReadAsync(Def("step-failures"), TargetWorkflowId, Window, CancellationToken.None);

        Assert.Contains(TargetWorkflowId.ToString("D"), handler.LastBody, StringComparison.Ordinal);
        Assert.DoesNotContain("{{WORKFLOW}}", handler.LastBody, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ElasticPanelSource_TranslatesAnHttpLevelErrorIntoPanelUnavailable()
    {
        var handler = new RecordingHandler(HttpStatusCode.NotFound, Fixture("elastic-index-not-found.json"));
        var source = new ElasticPanelSource(
            new HttpClient(handler, disposeHandler: false),
            Options.Create(new PanelSourceOptions { ElasticBaseUrl = "http://elasticsearch:9200" }));

        var ex = await Assert.ThrowsAsync<PanelUnavailableException>(
            () => source.ReadAsync(Def("step-outcomes"), TargetWorkflowId, Window, CancellationToken.None));

        Assert.Contains("elasticsearch", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task ElasticPanelSource_MissingBaseAddressFailsInTheDomainChannel()
    {
        // C2: no ElasticBaseUrl configured (a null Analyst:Panels:ElasticBaseUrl in production) means
        // the HttpClient has no BaseAddress, and a relative request URI throws InvalidOperationException
        // -- not HttpRequestException. That must still come out as PanelUnavailableException, not
        // escape the loop as a raw framework exception.
        var source = new ElasticPanelSource(
            new HttpClient(new RecordingHandler(HttpStatusCode.OK, "{}"), disposeHandler: false),
            Options.Create(new PanelSourceOptions { ElasticBaseUrl = null }));

        var ex = await Assert.ThrowsAsync<PanelUnavailableException>(
            () => source.ReadAsync(Def("step-outcomes"), TargetWorkflowId, Window, CancellationToken.None));

        Assert.Contains("elasticsearch", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task PrometheusPanelSource_UsesQueryRangeNeverAnInstantQuery()
    {
        var handler = new RecordingHandler(HttpStatusCode.OK, Fixture("prometheus-present-covering.json"));
        var source = new PrometheusPanelSource(
            new HttpClient(handler, disposeHandler: false),
            Options.Create(new PanelSourceOptions { PrometheusBaseUrl = "http://prometheus:9090" }));

        await source.ReadAsync(Def("queue-wait"), TargetWorkflowId, Window, CancellationToken.None);

        Assert.Equal(HttpMethod.Get, handler.LastMethod);
        Assert.Contains("/api/v1/query_range?", handler.LastPath, StringComparison.Ordinal);
        Assert.DoesNotContain("/api/v1/query?", handler.LastPath, StringComparison.Ordinal);
        // Grouped by the replica label (service_instance_id), never the scrape-target label.
        Assert.Contains("service_instance_id", handler.LastPath, StringComparison.Ordinal);
        Assert.Contains("&start=", handler.LastPath, StringComparison.Ordinal);
        Assert.Contains("&end=", handler.LastPath, StringComparison.Ordinal);
        Assert.Contains("&step=", handler.LastPath, StringComparison.Ordinal);
        // C1/C3: the target workflow id never reaches a Prometheus query -- pipeline_* series carry
        // no workflow label at all.
        Assert.DoesNotContain(TargetWorkflowId.ToString("D"), handler.LastPath, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task PrometheusPanelSource_ConsumerDurationMeanGroupsByQueueAndDisposition()
    {
        // I1: collapsing "disposition" would average a slow success together with a slow requeue --
        // during a store outage every bounced delivery is requeued and would drag the number while
        // the agent reads it as processing latency.
        var handler = new RecordingHandler(HttpStatusCode.OK, Fixture("prometheus-present-covering.json"));
        var source = new PrometheusPanelSource(
            new HttpClient(handler, disposeHandler: false),
            Options.Create(new PanelSourceOptions { PrometheusBaseUrl = "http://prometheus:9090" }));

        await source.ReadAsync(Def("consumer-duration-mean"), TargetWorkflowId, Window, CancellationToken.None);

        var decodedQuery = Uri.UnescapeDataString(handler.LastPath);
        Assert.Contains("disposition", decodedQuery, StringComparison.Ordinal);
        Assert.Contains("queue", decodedQuery, StringComparison.Ordinal);
        Assert.Contains("service_instance_id", decodedQuery, StringComparison.Ordinal);
        Assert.Contains("pipeline_consumer_duration_seconds_sum", decodedQuery, StringComparison.Ordinal);
    }

    [Fact]
    public async Task PrometheusPanelSource_TranslatesAnHttpLevelErrorIntoPanelUnavailable()
    {
        var handler = new RecordingHandler(HttpStatusCode.ServiceUnavailable, Fixture("prometheus-error.json"));
        var source = new PrometheusPanelSource(
            new HttpClient(handler, disposeHandler: false),
            Options.Create(new PanelSourceOptions { PrometheusBaseUrl = "http://prometheus:9090" }));

        var ex = await Assert.ThrowsAsync<PanelUnavailableException>(
            () => source.ReadAsync(Def("queue-wait"), TargetWorkflowId, Window, CancellationToken.None));

        Assert.Contains("prometheus", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task PrometheusPanelSource_MissingBaseAddressFailsInTheDomainChannel()
    {
        // C2, the Prometheus half.
        var source = new PrometheusPanelSource(
            new HttpClient(new RecordingHandler(HttpStatusCode.OK, "{}"), disposeHandler: false),
            Options.Create(new PanelSourceOptions { PrometheusBaseUrl = null }));

        var ex = await Assert.ThrowsAsync<PanelUnavailableException>(
            () => source.ReadAsync(Def("queue-wait"), TargetWorkflowId, Window, CancellationToken.None));

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

        var businessReading = await reader.ReadAsync("step-outcomes", TargetWorkflowId, Window, CancellationToken.None);
        var opsReading = await reader.ReadAsync("queue-wait", TargetWorkflowId, Window, CancellationToken.None);

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
