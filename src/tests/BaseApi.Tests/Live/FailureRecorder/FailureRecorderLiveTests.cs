using System.Diagnostics;
using System.IO.Compression;
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

    // Where a seed lands on the kind node, and the node's own name -- both borrowed from the
    // ChainLiveTests/FileFetcherLiveTests convention rather than shared with them, following this
    // file's existing pattern of keeping its live-infra plumbing self-contained.
    private const string NodeDir = "/mnt/skp-files/in";
    private static string Node => RealStack.Get("SKP_KIND_NODE", "desktop-control-plane");

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

    /// <summary>
    /// EVERY line of a lineage, not just the WARNs.
    /// <para>
    /// <b>Deliberately no <c>severity_text</c> filter, unlike <see cref="WarningsAsync"/>.</b> The
    /// line that carries the failed FILE PATH is not a warning at all -- it is
    /// <c>BaseImporter.ProcessAsync</c>'s ordinary "imported record {Record} as execution
    /// {ExecutionId} from {Origin}" line, logged at entry time, before anything downstream has had a
    /// chance to fail. Filtering to Warning would silently exclude the only line this test cares
    /// about.
    /// </para>
    /// <para>
    /// Otherwise identical to <see cref="WarningsAsync"/>, including the probe exclusion and the
    /// client-side scan of <c>body.text</c> -- that field is indexed as a <b>keyword</b> in this
    /// data stream, so a server-side <c>match</c>/<c>match_phrase</c> against it returns zero hits
    /// even for text that is plainly present. Filtering on the <c>attributes.*</c> term and scanning
    /// the returned bodies in C# is what actually works.
    /// </para>
    /// </summary>
    private static async Task<List<string>> LinesAsync(string field, string value)
    {
        using var http = new HttpClient { BaseAddress = new Uri(ElasticUrl) };
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(60);

        var query = $$$"""
        {
          "size": 50,
          "sort": [{"@timestamp": "asc"}],
          "query": {"bool": {
            "filter": [
              {"term": {"attributes.{{{field}}}": "{{{value}}}"}}
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

    /// <summary>
    /// Builds a one-entry archive that AcmeHandler refuses (a group with 0 .wav and 0 .json is
    /// never valid, so one arbitrary entry is enough -- there is no need to reproduce the two-CSV
    /// fixture ChainLiveTests uses) and copies it onto the node the FileFetcher pod mounts.
    /// Returns the exact absolute path FileFetcher will open, which is also the exact string this
    /// test later looks for inside a log line.
    /// </summary>
    private static string SeedArchive(string name)
    {
        var local = Path.Combine(Path.GetTempPath(), name);

        using (var file = File.Create(local))
        using (var archive = new ZipArchive(file, ZipArchiveMode.Create))
        using (var writer = new StreamWriter(archive.CreateEntry("a.csv").Open()))
        {
            writer.Write("id\n");
        }

        Run("docker", $"cp \"{local}\" {Node}:{NodeDir}/{name}");
        return $"{NodeDir}/{name}";
    }

    /// <summary>
    /// Puts the seeded path onto <c>skp-paths</c>, the way FileFetcher's own trigger does. The
    /// filePath key ALONE -- file-locator declares additionalProperties: false, so a second key
    /// would be refused by KafkaImporter's own output validation before the lineage even opens.
    /// </summary>
    private static async Task ProduceAsync(string path)
    {
        using var producer = new ProducerBuilder<Null, string>(
            new ProducerConfig { BootstrapServers = RealStack.KafkaBrokers }).Build();

        var result = await producer.ProduceAsync(RealStack.KafkaTopic, new Message<Null, string>
        {
            Value = JsonSerializer.Serialize(new { filePath = path }),
        });

        Assert.True(result.Status == PersistenceStatus.Persisted,
            $"produce to {RealStack.KafkaTopic} did not persist: status was {result.Status}");
    }

    /// <summary>Removes the seed from the node. A seed left behind fails the chain every 30s forever.</summary>
    private static void Cleanup(string path) => Run("docker", $"exec {Node} rm -f {path}");

    /// <summary>Runs a command and asserts it exited cleanly, mirroring ChainLiveTests' own helper.</summary>
    private static void Run(string file, string arguments)
    {
        using var process = Process.Start(new ProcessStartInfo(file, arguments)
        {
            RedirectStandardError = true,
        })!;

        if (!process.WaitForExit(60_000))
        {
            process.Kill(entireProcessTree: true);
            Assert.Fail($"{file} {arguments} did not exit within 60s and was killed");
        }

        Assert.True(process.ExitCode == 0,
            $"{file} {arguments} exited {process.ExitCode}: {process.StandardError.ReadToEnd()}");
    }

    [Fact]
    public async Task TheRecordLeadsToTheFileThatFailed()
    {
        RealStack.SkipUnlessEnabled();

        // WHY THE PATH IS RECOVERABLE AT ALL, given that FailureRecordJson deliberately carries no
        // path field:
        //
        // - skp-paths carries {"filePath": "..."} -- the ONLY place on the wire, anywhere in this
        //   chain, where the literal absolute path ever appears.
        // - KafkaImporterProcessor.Describe renders that record value VERBATIM into the entry-step
        //   log line ("imported record {Record} as execution {ExecutionId} from {Origin}", written
        //   by BaseImporter.ProcessAsync). That line is logged once, at the moment the path is
        //   opened, before anything downstream can fail -- so it survives independently of whatever
        //   the normalizer later does to the file's CONTENT.
        // - Every hop after the importer passes an ENVELOPE (bytes + ids), never the source path.
        //   FailureRecorder's own record is exactly that envelope's tail: {correlationId,
        //   executionId?, recordedAtUtc}, no path. So the importer's log line is the one and only
        //   place downstream of the failure where an operator can still read the path back -- which
        //   is why this test resolves it through Elasticsearch rather than through the record.
        var name = $"pathproof-{Guid.NewGuid():N}.zip";
        var path = SeedArchive(name);

        try
        {
            await ProduceAsync(path);

            // Same fresh-group, Latest drain the two tests above use: this sees only the failure
            // this seed produced, not the topic's backlog.
            var records = Drain(TimeSpan.FromSeconds(90));
            var record = Assert.Single(records);

            // This is the D5/mid-chain shape (SKNormalizer refuses a non-Acme item), so, like
            // AMidChainFailureProducesARecordNamingItsLineage, an executionId is present.
            Assert.True(record.TryGetProperty("executionId", out var executionIdProperty));
            var executionId = executionIdProperty.GetString()!;
            var correlationId = record.GetProperty("correlationId").GetString()!;

            // RESOLUTION #1: by execution id, against every line of the lineage (no severity
            // filter -- the importer's line is Information, not Warning). Asserting the EXACT path,
            // not merely "some line mentions a zip": the operator's question is which file broke,
            // and only the exact string answers it.
            var byExecution = await LinesAsync("ExecutionId", executionId);
            Assert.Contains(byExecution, line => line.Contains(path, StringComparison.Ordinal));

            // RESOLUTION #2: by correlation id. For THIS failure it is redundant with #1, since a
            // mid-chain failure has both ids -- but AnEntryStepFailureProducesARecordWithNoLineage
            // shows a real failure that has ONLY a correlation id (Rent/Open happens before an
            // execution id is minted), so correlation-only resolution has to work independently of
            // execution-id resolution, not merely as a side effect of it.
            var byCorrelation = await LinesAsync("CorrelationId", correlationId);
            Assert.Contains(byCorrelation, line => line.Contains(path, StringComparison.Ordinal));
        }
        finally
        {
            // Unconditional: a seed left on the node fails the chain again on its next tick, every
            // 30s, forever -- whether or not the assertions above passed.
            Cleanup(path);
        }
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
