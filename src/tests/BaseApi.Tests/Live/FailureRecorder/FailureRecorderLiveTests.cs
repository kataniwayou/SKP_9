using System.Net.Http;
using System.Text;
using System.Text.Json;
using Confluent.Kafka;
using Xunit;

namespace BaseApi.Tests.Live.FailureRecorder;

/// <summary>
/// The half of FailureRecorder only the cluster can answer: a step really fails, the PreviousFailed
/// edge really fires, and a record really lands on skp-failures — with an id that really resolves a
/// lineage in a real log store. The hermetic suite runs the transform in process and can say nothing
/// about any of that.
/// <para>
/// Needs <c>SKP_REALSTACK=1</c>, <c>k8s/port-forward-realstack.ps1</c> and
/// <c>tools/kafka-dev-broker.ps1 -Up</c>, plus the wiring from Task 6.
/// </para>
/// </summary>
[Trait("Category", RealStack.Category)]
[Collection("kafka-broker")]
public sealed class FailureRecorderLiveTests
{
    private const string FailuresTopic = "skp-failures";
    private const string LogIndex = "logs-generic.otel-default";

    private static string ElasticUrl => RealStack.Get("SKP_ES_URL", "http://localhost:19200");

    /// <summary>
    /// Reads whatever lands on the failures topic between now and the deadline.
    /// <para>
    /// A fresh group id per call, with <c>AutoOffsetReset.Latest</c>: this test must see what ITS
    /// failure produced, not the backlog of every failure since the topic was created.
    /// </para>
    /// </summary>
    private static List<JsonElement> Drain(TimeSpan window)
    {
        using var consumer = new ConsumerBuilder<Ignore, string>(new ConsumerConfig
        {
            BootstrapServers = RealStack.KafkaBrokers,
            GroupId = $"failure-recorder-test-{Guid.NewGuid():N}",
            AutoOffsetReset = AutoOffsetReset.Latest,
            EnableAutoCommit = false,
        }).Build();

        consumer.Subscribe(FailuresTopic);

        var records = new List<JsonElement>();
        var deadline = DateTime.UtcNow + window;

        while (DateTime.UtcNow < deadline)
        {
            var result = consumer.Consume(TimeSpan.FromSeconds(2));
            if (result?.Message?.Value is { Length: > 0 } value)
            {
                records.Add(JsonDocument.Parse(value).RootElement.Clone());
            }
        }

        consumer.Close();
        return records;
    }

    /// <summary>
    /// The WARN lines of one lineage, polled to a deadline.
    /// <para>
    /// <b>The poll is not politeness, it is the measured ingest lag.</b> The newest indexed record
    /// on this cluster runs 7-14s behind now, and the line this test wants is the LAST one the
    /// failing pod writes — so a single immediate query reliably returns nothing, and reads as a
    /// missing log rather than a late one.
    /// </para>
    /// </summary>
    private static async Task<List<string>> WarningsAsync(string field, string value)
    {
        using var http = new HttpClient { BaseAddress = new Uri(ElasticUrl) };
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(60);

        var query = $$$"""
        {
          "size": 20,
          "sort": [{"@timestamp": "asc"}],
          "query": {"bool": {
            "filter": [
              {"term": {"attributes.{{{field}}}": "{{{value}}}"}},
              {"term": {"severity_text": "Warning"}}
            ],
            "must_not": [{"term": {"scope.name": "BaseConsole.Core.Health.HealthProbeLog"}}]
          }}
        }
        """;

        while (DateTime.UtcNow < deadline)
        {
            var response = await http.PostAsync(
                $"/{LogIndex}/_search",
                new StringContent(query, Encoding.UTF8, "application/json"));

            var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            var hits = body.RootElement.GetProperty("hits").GetProperty("hits");

            if (hits.GetArrayLength() > 0)
            {
                return hits.EnumerateArray()
                    .Select(h => h.GetProperty("_source").GetProperty("body").GetProperty("text").GetString() ?? "")
                    .ToList();
            }

            await Task.Delay(TimeSpan.FromSeconds(3));
        }

        return [];
    }

    [Fact]
    public async Task AMidChainFailureProducesARecordNamingItsLineage()
    {
        RealStack.SkipUnlessEnabled();

        // The D5 shape: an archive whose entries are not exactly one .wav + one .json pair, which
        // AcmeHandler.ValidateContent refuses. Seeded (see Step 3) where FileFetcher picks it up.
        // The chain fires on 5,35 * * * * *, so one fire is at most 30s away; 90s covers that plus
        // the chain's own hops plus slack.
        var records = Drain(TimeSpan.FromSeconds(90));

        var record = Assert.Single(records);

        // "N" — 32 hex, no dashes — which is the form Elasticsearch holds, and the reason the query
        // below matches at all.
        var correlation = record.GetProperty("correlationId").GetString()!;
        Assert.Equal(32, correlation.Length);
        Assert.DoesNotContain('-', correlation);

        // "D", dashed, and present because the step that failed had a lineage.
        Assert.True(record.TryGetProperty("executionId", out var executionId));
        var execution = executionId.GetString()!;
        Assert.True(Guid.TryParse(execution, out _));

        Assert.True(record.TryGetProperty("recordedAtUtc", out _));

        // The pointer resolves: the lineage it names ends in two WARN lines — one from the processor
        // carrying the reason, one from the orchestrator routing the failure onward.
        //
        // CORRECTED FROM THE BRIEF: the brief expected "no successor accepts it", which is
        // StepOutcomeHandler's TERMINAL-step line (src/Orchestrator/Messaging/StepOutcomeHandler.cs,
        // "the terminal step completed with {Result} — no successor accepts it, the run ends here")
        // — logged only when a step has NO successor at all. That was true before Task 6 wired the
        // PreviousFailed edge; it is no longer true now. The normalizer step this test fails now HAS
        // a successor (FailureRecorder), so its outcome takes the other branch in the same method:
        // "advancing {SuccessorCount} successor(s) on a {Result} step — their entry conditions
        // accept it". Asserting the brief's original text would assert the wiring is ABSENT — the
        // opposite of what Task 6 shipped and what this whole test exists to prove. Verified against
        // both the source (StepOutcomeHandler.cs:333-336) and the live index: querying
        // logs-generic.otel-default for the literal phrase "no successor accepts it" returns 0 hits
        // for this run's ExecutionId, while "advancing 1 successor(s) on a Failed step" is present.
        var warnings = await WarningsAsync("ExecutionId", execution);

        Assert.Contains(warnings, w => w.Contains("the author reported the step failed"));
        Assert.Contains(warnings, w => w.Contains("advancing 1 successor(s) on a Failed step"));
    }

    [Fact]
    public async Task AnEntryStepFailureProducesARecordWithNoLineage()
    {
        RealStack.SkipUnlessEnabled();

        // Step 3 points the importer's assignment at a topic it will never be assigned, so Open
        // returns false within the idle timeout and the step fails before opening any lineage.
        var records = Drain(TimeSpan.FromSeconds(90));

        var record = Assert.Single(records);

        // OMITTED, not zeroed: "the failed step had no lineage" must stay distinguishable from
        // "this field was not populated". This assertion is what fails if FailureRecordJson ever
        // loses WhenWritingNull.
        Assert.False(record.TryGetProperty("executionId", out _));

        var correlation = record.GetProperty("correlationId").GetString()!;
        Assert.Equal(32, correlation.Length);

        // It still resolves — by correlation rather than execution, which is the entire reason the
        // accessor in Task 1 exists.
        //
        // CORRECTED FROM THE BRIEF: the brief expected "was not ready within", which is
        // BaseImporter's message for the OTHER way an importer can fail to open — Open() returning
        // false after librdkafka quietly times out waiting for a partition assignment (see
        // src/BaseProcessor.Core/Edge/BaseImporter.cs, "{SourceName(config)} was not ready within
        // {idle}"). That is what happens against a topic that EXISTS but is never assigned to this
        // group. It is not what happens here: "skp-nothing-publishes-here" does not exist at all, so
        // librdkafka surfaces UnknownTopicOrPart as an exception during WaitForAssignment, which
        // Open() lets through and BaseImporter converts on the OTHER branch — the catch around
        // source.Open(idle) — into "opening {SourceName(config)} failed: {ex.Message}". Both branches
        // fail the step before any lineage opens (Rent/Open happens before the read loop that mints
        // an execution id), so the record's shape — no executionId — is exactly what the brief
        // predicted; only the wording of the WARN line differs. Confirmed against the live index: the
        // three WARN lines for this run's CorrelationId are "the author reported the step failed:
        // opening skp-nothing-publishes-here failed: UnknownTopicOrPart", "the entry step completed
        // with Failed", and "advancing 1 successor(s) on a Failed step — their entry conditions
        // accept it" — no line anywhere contains "was not ready within".
        var warnings = await WarningsAsync("CorrelationId", correlation);

        Assert.Contains(warnings, w => w.Contains("opening skp-nothing-publishes-here failed"));
    }
}
