using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Messaging.Contracts;
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
/// <see cref="PrometheusPanelSource"/>'s own doc comment.
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

    /// <summary>The target workflow, as the run-boundaries tests name it.</summary>
    private static readonly Guid W = TargetWorkflowId;

    /// <summary>The busy-mixed-feed window's fifteen minutes: the esql-* fixtures' first entry is 19:08:00.408Z.</summary>
    private static readonly TimeRange Range = new(
        new DateTimeOffset(2026, 10, 1, 19, 8, 0, TimeSpan.Zero),
        new DateTimeOffset(2026, 10, 1, 19, 23, 0, TimeSpan.Zero));

    private static PanelDefinition RunBoundaries => Def("run-boundaries");

    /// <summary>An Elastic source answering successive requests with <paramref name="responses"/>, in order.</summary>
    private static ElasticPanelSource ElasticSource(params string[] responses) => ElasticSource(new SequencedHandler(responses));

    private static ElasticPanelSource ElasticSource(SequencedHandler handler) => new(
        new HttpClient(handler, disposeHandler: false),
        Options.Create(new PanelSourceOptions { ElasticBaseUrl = "http://elasticsearch:9200" }));

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
    public void Elastic_RefusedMessages_ReportsQueuesOutcomesAndTheExceptionThatCausedThem()
    {
        var reading = ElasticPanelSource.Parse(
            Def("refused-messages"), Window, Fixture("elastic-refusals-present.json"));

        Assert.True(reading.Trust.SeriesPresent);
        Assert.True(reading.Trust.NoDataDistinguishable);
        Assert.True(reading.Trust.WindowFullyCovered);

        // SampleCount is the scope total (612), matching every other Elastic panel's convention --
        // not the refusal count. A window with four refusals out of 612 records is not a panel that
        // returned four things.
        Assert.Equal(612, reading.SampleCount);

        using var value = JsonDocument.Parse(reading.ValueJson);
        var root = value.RootElement;

        Assert.Equal(4, root.GetProperty("refusedCount").GetInt64());

        // The two outcomes counted apart. This is the distinction the whole panel turns on: a park
        // landed in a dead-letter queue and can be recovered, a NOT-parked refusal was redelivered
        // and there is nothing in a dead-letter queue to go and look at.
        Assert.Equal(3, root.GetProperty("parked").GetInt64());
        Assert.Equal(1, root.GetProperty("notParked").GetInt64());

        // Attributed to queues, which dead-letter-depth can also do -- but here scoped to the
        // workflow, which dead-letter-depth cannot do at all.
        var byQueue = root.GetProperty("byQueue");
        Assert.Equal(3, byQueue.GetProperty("orchestrator-result").GetInt64());
        Assert.Equal(1, byQueue.GetProperty("processor-filefetcher-in").GetInt64());

        // The exception is WHY it was refused, and the most useful field on the record.
        Assert.Contains("FileNotFoundException", reading.ValueJson, StringComparison.Ordinal);
        Assert.Contains("disappeared between poll and fetch", reading.ValueJson, StringComparison.Ordinal);
    }

    [Fact]
    public void Elastic_RefusedMessages_NoRefusalsWhileTheWorkflowIsReportingIsATrustedZero()
    {
        // The reading this panel returns almost always, and the one that has to be believable: 940
        // records exist for the workflow in the window and not one of them is a refusal. That is a
        // real all-clear, and it is drawable ONLY because the query's scope is every record for the
        // workflow rather than the refusals themselves -- scoped to refusals, an empty response could
        // not be told apart from an ingest outage, and this panel would be useless in exactly the
        // case it is read in most often.
        var reading = ElasticPanelSource.Parse(
            Def("refused-messages"), Window, Fixture("elastic-refusals-zero.json"));

        Assert.True(reading.Trust.SeriesPresent);
        Assert.True(reading.Trust.NoDataDistinguishable);
        Assert.Equal(940, reading.SampleCount);

        using var value = JsonDocument.Parse(reading.ValueJson);
        Assert.Equal(0, value.RootElement.GetProperty("refusedCount").GetInt64());
        Assert.Equal(0, value.RootElement.GetProperty("samples").GetArrayLength());
    }

    [Fact]
    public void Elastic_RefusedMessages_NoRecordsAtAllIsStillReportedAsABlindSpot()
    {
        // The other side of the same line. This panel shares the zero-documents branch with the other
        // Elastic panels, and must not quietly inherit their noun for it: the scope here is every
        // record for the workflow, not outcome records, and a reading that calls 0 "outcome records"
        // when it counted something else is the kind of small dishonesty the model cannot check.
        var reading = ElasticPanelSource.Parse(
            Def("refused-messages"), Window, Fixture("elastic-outcomes-zero-documents.json"));

        Assert.False(reading.Trust.SeriesPresent);
        Assert.False(reading.Trust.NoDataDistinguishable);
        Assert.Equal(0, reading.SampleCount);

        using var value = JsonDocument.Parse(reading.ValueJson);
        Assert.Equal(0, value.RootElement.GetProperty("totalWorkflowRecords").GetInt64());
    }

    [Fact]
    public void Elastic_RefusedMessages_QueryCarriesTheTemplatesTheConsumerActuallyEmits()
    {
        // The end-to-end pin for the hoist: the shipped query selects on the same constants
        // GatedQueueConsumer logs (RefusalTemplateTests holds the emitter, the live suite and the
        // Kibana export to those same two). Without this the panel could drift to a stale template
        // and keep returning a confident, trusted zero forever.
        var query = Def("refused-messages").Query;

        Assert.Contains(RefusalTemplates.Parked, query, StringComparison.Ordinal);
        Assert.Contains(RefusalTemplates.NotParked, query, StringComparison.Ordinal);
    }

    // ---------------------------------------------------------------------------------------
    // run-boundaries: the run's two StepRole edges, read over ES|QL.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public async Task TheEdgesCarryEntryAndEveryTerminalStep()
    {
        var reading = await ElasticSource(Fixture("esql-fires.json"), Fixture("esql-edges-healthy.json"), Fixture("esql-polls.json"))
            .ReadAsync(RunBoundaries, W, Range, CancellationToken.None);

        using var value = JsonDocument.Parse(reading.ValueJson);
        var root = value.RootElement;
        Assert.Equal(15, root.GetProperty("fires").GetInt64());
        Assert.Equal(125, root.GetProperty("recordsImported").GetInt64());
        var rows = root.GetProperty("byStep").EnumerateArray().ToList();
        // The real graph's shape: export-outcome is the only step with no successors.
        Assert.Equal(2, rows.Count);
        Assert.Equal(15, rows.Single(r => r.GetProperty("role").GetString() == "entry").GetProperty("records").GetInt64());
        Assert.Equal(75, rows.Where(r => r.GetProperty("role").GetString() == "terminal").Sum(r => r.GetProperty("records").GetInt64()));
        Assert.False(root.TryGetProperty("roleRecords", out _));
        Assert.Equal(90, reading.SampleCount);
        Assert.True(reading.Trust.WindowFullyCovered);
        Assert.True(reading.Trust.NoDataDistinguishable);
    }

    [Fact]
    public async Task ADrainedWindowCarriesNothingImported()
    {
        // Every poll empty: entry records, no terminal, nothing imported. The panel must carry
        // recordsImported 0 so the reading is a quiet window, not a stall.
        const string drained =
            """{"columns":[{"name":"importerPolls","type":"long"},{"name":"drainedPolls","type":"long"},{"name":"recordsImported","type":"long"}],"values":[[15,15,0]]}""";

        var reading = await ElasticSource(Fixture("esql-fires.json"), Fixture("esql-edges-stalled.json"), drained)
            .ReadAsync(RunBoundaries, W, Range, CancellationToken.None);

        using var value = JsonDocument.Parse(reading.ValueJson);
        Assert.Equal(0, value.RootElement.GetProperty("recordsImported").GetInt64());
        Assert.Equal(0, value.RootElement.GetProperty("pollsThatImported").GetInt64());
        Assert.True(reading.Trust.NoDataDistinguishable);
    }

    [Fact]
    public async Task TwoEntryStepsAreTwoEntryRowsButOneFire()
    {
        const string twoEntries =
            """{"columns":[{"name":"records","type":"long"},{"name":"attributes.StepRole","type":"keyword"},{"name":"attributes.StepName","type":"keyword"}],"values":[[15,"entry","importer-a"],[15,"entry","importer-b"]]}""";

        var reading = await ElasticSource(Fixture("esql-fires.json"), twoEntries, Fixture("esql-polls.json"))
            .ReadAsync(RunBoundaries, W, Range, CancellationToken.None);

        using var value = JsonDocument.Parse(reading.ValueJson);
        Assert.Equal(15, value.RootElement.GetProperty("fires").GetInt64());
        Assert.Equal(2, value.RootElement.GetProperty("byStep").GetArrayLength());
    }

    [Fact]
    public async Task TheEdgesCarryTheWorkflowsScopeCount()
    {
        var reading = await ElasticSource(Fixture("esql-fires.json"), Fixture("esql-edges-healthy.json"), Fixture("esql-polls.json"))
            .ReadAsync(RunBoundaries, W, Range, CancellationToken.None);

        using var value = JsonDocument.Parse(reading.ValueJson);
        Assert.Equal(6213, value.RootElement.GetProperty("totalWorkflowRecords").GetInt64());
        Assert.True(reading.Trust.SeriesPresent);
        Assert.True(reading.Trust.NoDataDistinguishable);
    }

    [Fact]
    public async Task AWindowWithNoWorkflowRecordsAtAllIsIndistinguishableFromNothingReported()
    {
        // The workflow logged nothing in the window: dead logging and an idle workflow read the same,
        // so -- as on the _search panels -- every trust flag is false, never a trusted fires:0.
        const string noEdges =
            """{"columns":[{"name":"records","type":"long"},{"name":"attributes.StepRole","type":"keyword"},{"name":"attributes.StepName","type":"keyword"}],"values":[]}""";
        const string noPolls =
            """{"columns":[{"name":"importerPolls","type":"long"},{"name":"drainedPolls","type":"long"},{"name":"recordsImported","type":"long"}],"values":[[0,null,null]]}""";

        var reading = await ElasticSource(Fixture("esql-fires-no-records.json"), noEdges, noPolls)
            .ReadAsync(RunBoundaries, W, Range, CancellationToken.None);

        using var value = JsonDocument.Parse(reading.ValueJson);
        Assert.Equal(0, value.RootElement.GetProperty("totalWorkflowRecords").GetInt64());
        Assert.False(reading.Trust.SeriesPresent);
        Assert.False(reading.Trust.WindowFullyCovered);
        Assert.False(reading.Trust.NoDataDistinguishable);
        Assert.Equal(0, reading.SampleCount);
    }

    [Fact]
    public async Task APartialEsqlResponseIsPanelUnavailableNotATrustedUndercount()
    {
        // is_partial: some shards did not answer. A partial reading undercounts the terminal edge and
        // would read as a trusted stall; the _search path refuses the same case (failed shards).
        var ex = await Assert.ThrowsAsync<PanelUnavailableException>(
            () => ElasticSource(Fixture("esql-fires.json"), Fixture("esql-edges-partial.json"), Fixture("esql-polls.json"))
                .ReadAsync(RunBoundaries, W, Range, CancellationToken.None));

        Assert.Contains("partial", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task AStalledWindowIsATrustedEntryOnlyReading()
    {
        var reading = await ElasticSource(Fixture("esql-fires.json"), Fixture("esql-edges-stalled.json"), Fixture("esql-polls.json"))
            .ReadAsync(RunBoundaries, W, Range, CancellationToken.None);

        using var value = JsonDocument.Parse(reading.ValueJson);
        Assert.Equal("entry", Assert.Single(value.RootElement.GetProperty("byStep").EnumerateArray()).GetProperty("role").GetString());
        Assert.True(reading.Trust.SeriesPresent);
        Assert.True(reading.Trust.WindowFullyCovered);
    }

    [Fact]
    public async Task TheEdgesKeepEachStepsNameAndCountAndSumThemAsTheSampleCount()
    {
        var reading = await ElasticSource(Fixture("esql-fires.json"), Fixture("esql-edges-healthy.json"), Fixture("esql-polls.json"))
            .ReadAsync(RunBoundaries, W, Range, CancellationToken.None);

        using var value = JsonDocument.Parse(reading.ValueJson);
        var first = value.RootElement.GetProperty("byStep")[0];
        // The fixture lists records FIRST: the columns are read by name, never by position.
        Assert.Equal("terminal", first.GetProperty("role").GetString());
        Assert.Equal("export-outcome", first.GetProperty("step").GetString());
        Assert.Equal(75, first.GetProperty("records").GetInt64());
        Assert.Equal(15, value.RootElement.GetProperty("importerPolls").GetInt64());
        Assert.Equal(0, value.RootElement.GetProperty("drainedPolls").GetInt64());
        Assert.Equal(75 + 15, reading.SampleCount);
        Assert.True(reading.Trust.NoDataDistinguishable);
    }

    [Fact]
    public async Task AFirstEntryWellAfterTheWindowStartIsNotFullyCovered()
    {
        const string lateFires =
            """{"columns":[{"name":"totalWorkflowRecords","type":"long"},{"name":"fires","type":"long"},{"name":"earliest","type":"date"}],"values":[[4100,9,"2026-10-01T19:14:00.000Z"]]}""";

        var reading = await ElasticSource(lateFires, Fixture("esql-edges-healthy.json"), Fixture("esql-polls.json"))
            .ReadAsync(RunBoundaries, W, Range, CancellationToken.None);

        Assert.False(reading.Trust.WindowFullyCovered);
    }

    [Fact]
    public async Task NoFireInTheWindowReadsZeroAndIsNotFullyCovered()
    {
        // The workflow is logging (40 records) but no fire entered. STATS with no BY over zero rows
        // answers one row: COUNT_DISTINCT 0, MIN null, SUM null.
        const string noFires =
            """{"columns":[{"name":"totalWorkflowRecords","type":"long"},{"name":"fires","type":"long"},{"name":"earliest","type":"date"}],"values":[[40,0,null]]}""";
        const string noEdges =
            """{"columns":[{"name":"records","type":"long"},{"name":"attributes.StepRole","type":"keyword"},{"name":"attributes.StepName","type":"keyword"}],"values":[]}""";
        const string noPolls =
            """{"columns":[{"name":"importerPolls","type":"long"},{"name":"drainedPolls","type":"long"},{"name":"recordsImported","type":"long"}],"values":[[0,null,null]]}""";

        var reading = await ElasticSource(noFires, noEdges, noPolls).ReadAsync(RunBoundaries, W, Range, CancellationToken.None);

        using var value = JsonDocument.Parse(reading.ValueJson);
        Assert.Equal(0, value.RootElement.GetProperty("fires").GetInt64());
        Assert.Equal(0, value.RootElement.GetProperty("drainedPolls").GetInt64());
        Assert.Equal(0, value.RootElement.GetProperty("recordsImported").GetInt64());
        Assert.Equal(0, value.RootElement.GetProperty("byStep").GetArrayLength());
        Assert.True(reading.Trust.SeriesPresent);
        Assert.False(reading.Trust.WindowFullyCovered);
    }

    [Fact]
    public async Task TheEdgesPostEachStatementToQueryAsEscapedJson()
    {
        var handler = new SequencedHandler(
            Fixture("esql-fires.json"), Fixture("esql-edges-healthy.json"), Fixture("esql-polls.json"));

        await ElasticSource(handler).ReadAsync(RunBoundaries, W, Range, CancellationToken.None);

        Assert.Equal(3, handler.Requests.Count);
        Assert.All(handler.Requests, r =>
        {
            Assert.Equal(HttpMethod.Post, r.Method);
            // allow_partial_results=false: Elasticsearch fails the request rather than answering
            // with a partial result (the is_partial check stays as the second guard).
            Assert.Equal("/_query?allow_partial_results=false", r.Path);

            // The statements carry quotes (the polls statement also the backticked {OriginalFormat}
            // field): each must arrive as a JSON string, not spliced raw into the body.
            using var body = JsonDocument.Parse(r.Body);
            var statement = body.RootElement.GetProperty("query").GetString()!;
            Assert.StartsWith($"FROM {PanelRegistry.ElasticIndex}", statement, StringComparison.Ordinal);
            Assert.Contains($"attributes.WorkflowId == \"{W:D}\"", statement, StringComparison.Ordinal);
            Assert.Contains("\"2026-10-01T19:08:00", statement, StringComparison.Ordinal);
            Assert.DoesNotContain("{{", statement, StringComparison.Ordinal);
            Assert.DoesNotContain("---", statement, StringComparison.Ordinal);
        });

        using var polls = JsonDocument.Parse(handler.Requests[2].Body);
        Assert.Contains("attributes.`{OriginalFormat}`", polls.RootElement.GetProperty("query").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnHttpErrorOnAnyEdgesStatementIsPanelUnavailable()
    {
        var handler = new SequencedHandler(Fixture("esql-fires.json"), Fixture("elastic-index-not-found.json"))
        {
            StatusFor = i => i == 1 ? HttpStatusCode.BadRequest : HttpStatusCode.OK,
        };

        var ex = await Assert.ThrowsAsync<PanelUnavailableException>(
            () => ElasticSource(handler).ReadAsync(RunBoundaries, W, Range, CancellationToken.None));

        Assert.Contains("elasticsearch", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("""{"columns":[{"name":"something_else","type":"long"}],"values":[[1]]}""")]
    [InlineData("""{"error":{"type":"verification_exception","reason":"Unknown column"}}""")]
    public async Task AnUnreadableEdgesResponseIsPanelUnavailable(string fires)
    {
        await Assert.ThrowsAsync<PanelUnavailableException>(
            () => ElasticSource(fires, Fixture("esql-edges-healthy.json"), Fixture("esql-polls.json"))
                .ReadAsync(RunBoundaries, W, Range, CancellationToken.None));
    }

    [Fact]
    public void TheEdgesSelectOnTheValuesTheOrchestratorActuallyWrites()
    {
        // End-to-end pin: the panel selects on the same constants the orchestrator stamps, not on a
        // literal retyped into the query. The edges are the StepRole records themselves, so no
        // outcome template selects them.
        var query = RunBoundaries.Query;

        Assert.Equal(PanelKind.Esql, RunBoundaries.Kind);
        Assert.Contains($"attributes.{StepRoles.Key} == \"{StepRoles.Entry}\"", query, StringComparison.Ordinal);
        Assert.Contains($"attributes.{StepRoles.Key} IS NOT NULL", query, StringComparison.Ordinal);
        Assert.DoesNotContain(OutcomeTemplates.BranchEnds, query, StringComparison.Ordinal);
        Assert.DoesNotContain(OutcomeTemplates.Advanced, query, StringComparison.Ordinal);
        Assert.DoesNotContain("$", query, StringComparison.Ordinal);
    }

    [Fact]
    public async Task LivePanelReader_RoutesTheEdgesToElasticsearchsQueryEndpoint()
    {
        var handler = new SequencedHandler(
            Fixture("esql-fires.json"), Fixture("esql-edges-healthy.json"), Fixture("esql-polls.json"));
        var reader = new LivePanelReader(
            ElasticSource(handler),
            new PrometheusPanelSource(
                new HttpClient(new RecordingHandler(HttpStatusCode.OK, "{}"), disposeHandler: false),
                Options.Create(new PanelSourceOptions { PrometheusBaseUrl = "http://prometheus:9090" })));

        var reading = await reader.ReadAsync("run-boundaries", W, Range, history: false, CancellationToken.None);

        Assert.Equal("business", reading.Layer);
        Assert.Equal(3, handler.Requests.Count);
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

        await source.ReadAsync(Def("queue-wait"), TargetWorkflowId, Window, history: false, CancellationToken.None);

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

        await source.ReadAsync(Def("consumer-duration-mean"), TargetWorkflowId, Window, history: false, CancellationToken.None);

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
            () => source.ReadAsync(Def("queue-wait"), TargetWorkflowId, Window, history: false, CancellationToken.None));

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
            () => source.ReadAsync(Def("queue-wait"), TargetWorkflowId, Window, history: false, CancellationToken.None));

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

        var businessReading = await reader.ReadAsync("step-outcomes", TargetWorkflowId, Window, history: false, CancellationToken.None);
        var opsReading = await reader.ReadAsync("queue-wait", TargetWorkflowId, Window, history: false, CancellationToken.None);

        Assert.Equal("business", businessReading.Layer);
        Assert.Equal("ops", opsReading.Layer);
        Assert.NotNull(elasticHandler.LastMethod);
        Assert.NotNull(prometheusHandler.LastMethod);
    }

    [Fact]
    public async Task LivePanelReader_PassesHistoryThroughToThePrometheusStep()
    {
        var handler = new RecordingHandler(HttpStatusCode.OK, Fixture("prometheus-present-covering.json"));
        var reader = BuildReader(new RecordingHandler(HttpStatusCode.OK, "{}"), handler);
        var thirtyDays = new TimeRange(Window.To.AddDays(-30), Window.To);

        await reader.ReadAsync("queue-wait", TargetWorkflowId, thirtyDays, history: true, CancellationToken.None);
        var historyStep = handler.LastPath;
        await reader.ReadAsync("queue-wait", TargetWorkflowId, thirtyDays, history: false, CancellationToken.None);
        var windowStep = handler.LastPath;

        // ceil(30d / 47 / 1min) = 920 minutes; the window read keeps the 300-point step (8640s).
        Assert.Contains("&step=55200s", historyStep, StringComparison.Ordinal);
        Assert.Contains("&step=8640s", windowStep, StringComparison.Ordinal);
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
        // F3: PanelUnavailableException, not a raw ArgumentException -- an unknown panel id is the
        // same class of problem as an unreachable source (the analysis cannot proceed on it), and
        // AnalystProcessor only catches AnalysisImpossibleException plus a filtered
        // OperationCanceledException. A raw ArgumentException used to escape both, landing in the
        // framework's generic fault branch instead of a clean failed step.
        var reader = BuildReader(
            new RecordingHandler(HttpStatusCode.OK, "{}"), new RecordingHandler(HttpStatusCode.OK, "{}"));

        Assert.Throws<PanelUnavailableException>(() => reader.Describe("does-not-exist"));
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

    /// <summary>
    /// Answers the i-th request with the i-th body (and <see cref="StatusFor"/>'s status, 200 by
    /// default), recording every request. A request past the last body fails the test outright.
    /// </summary>
    private sealed class SequencedHandler(params string[] bodies) : HttpMessageHandler
    {
        internal List<(HttpMethod Method, string Path, string Body)> Requests { get; } = [];

        internal Func<int, HttpStatusCode> StatusFor { get; init; } = _ => HttpStatusCode.OK;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var index = Requests.Count;
            Requests.Add((
                request.Method,
                request.RequestUri?.PathAndQuery ?? string.Empty,
                request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(ct)));

            Assert.True(index < bodies.Length, $"unexpected request #{index + 1}: only {bodies.Length} responses were scripted");

            return new HttpResponseMessage(StatusFor(index))
            {
                Content = new StringContent(bodies[index], Encoding.UTF8, "application/json"),
            };
        }
    }

    [Fact]
    public async Task FailureCausesCarryEachCauseAndTheSharePerBucket()
    {
        var reading = await ElasticSource(Fixture("esql-causes.json"), Fixture("esql-cause-buckets.json"))
            .ReadEsqlAsync(Def("failure-causes"), W, Range, CancellationToken.None);

        using var value = JsonDocument.Parse(reading.ValueJson);
        var causes = value.RootElement.GetProperty("causes").EnumerateArray().ToList();
        Assert.Equal(3, causes.Count);
        Assert.All(causes, c => Assert.Equal("author-reported", c.GetProperty("logged").GetString()));
        Assert.Equal(24, causes.Sum(c => c.GetProperty("count").GetInt64()));

        var last = value.RootElement.GetProperty("buckets").EnumerateArray().Last();
        Assert.Equal(0.6, last.GetProperty("failedShare").GetDouble(), 3);
        Assert.Equal(24, reading.SampleCount);
        Assert.True(reading.Trust.SeriesPresent);
    }

    [Fact]
    public async Task NoFailuresIsATrustedZeroWhenTheWorkflowLoggedOutcomes()
    {
        var reading = await ElasticSource(
                """{"columns":[{"name":"count","type":"long"}],"values":[]}""",
                Fixture("esql-cause-buckets.json"))
            .ReadEsqlAsync(Def("failure-causes"), W, Range, CancellationToken.None);

        Assert.Equal(0, reading.SampleCount);
        Assert.True(reading.Trust.NoDataDistinguishable);
    }

    [Theory]
    [InlineData(15, "1 minute")]
    [InlineData(48 * 60, "60 minutes")]
    [InlineData(1100, "23 minutes")]
    public void TheBucketKeepsAHistoryReadUnderFortyEightBuckets(int minutes, string expected)
        => Assert.Equal(expected, ElasticPanelSource.BucketFor(new TimeRange(Range.From, Range.From.AddMinutes(minutes))));
}
