using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using BaseApi.Tests.Live.Resilience;
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
    /// A consumer that is ALREADY LISTENING on the failures topic, so a record written moments later
    /// cannot slip past it.
    /// <para>
    /// <b>This exists because subscribing after the seed is produced loses the record.</b> The drain
    /// used to be one call made AFTER ProduceAsync: it subscribed with AutoOffsetReset.Latest, and a
    /// fresh consumer group waits out group.initial.rebalance.delay.ms -- 3s, which the dev broker
    /// keeps on purpose -- before it is assigned a partition. "Latest" is pinned AT ASSIGNMENT, so
    /// anything written during that window is skipped, permanently, and the poll then runs to its
    /// deadline and reports that nothing ever arrived.
    /// </para>
    /// <para>
    /// <b>It hid for as long as the chain was slower than the rebalance.</b> Measured on 2026-09-16,
    /// the records for two consecutive runs landed at 13:04:05 and 13:09:05 -- about five seconds
    /// after each test began -- while both drains polled a further five minutes and saw nothing.
    /// Earlier the same day, when the chain answered in ninety seconds, the same tests passed. Widening
    /// the deadline cannot fix it: the record is missed before the wait even starts, which is why
    /// four minutes and five minutes failed identically.
    /// </para>
    /// </summary>
    private sealed class FailureDrain : IDisposable
    {
        private readonly IConsumer<Ignore, string> _consumer;

        private FailureDrain(IConsumer<Ignore, string> consumer) => _consumer = consumer;

        /// <summary>
        /// Subscribes and returns only once the broker has actually assigned a partition, which is
        /// the whole point: the caller seeds AFTER this returns.
        /// </summary>
        public static FailureDrain Start()
        {
            var consumer = new ConsumerBuilder<Ignore, string>(new ConsumerConfig
            {
                BootstrapServers = RealStack.KafkaBrokers,
                GroupId = $"failure-recorder-test-{Guid.NewGuid():N}",
                AutoOffsetReset = AutoOffsetReset.Latest,
                EnableAutoCommit = false,
            }).Build();

            consumer.Subscribe(FailuresTopic);

            // Polling is what drives the join; Assignment stays empty until the coordinator answers.
            var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(60);
            while (DateTime.UtcNow < deadline && consumer.Assignment.Count == 0)
            {
                consumer.Consume(TimeSpan.FromMilliseconds(500));
            }

            Assert.True(consumer.Assignment.Count > 0,
                $"no partition of {FailuresTopic} was assigned within 60s, so a record written after "
                + "this point could not have been observed");

            return new FailureDrain(consumer);
        }

        /// <summary>
        /// Reads until the record arrives, then keeps reading briefly in case the seed produced more
        /// than one.
        /// <para>
        /// <b>The settle read is what keeps <c>Assert.Single</c> meaningful.</b> Returning on the
        /// first message would let a duplicate record -- one seed recorded twice -- pass silently.
        /// </para>
        /// </summary>
        public List<JsonElement> Collect(TimeSpan window)
        {
            var records = new List<JsonElement>();
            var deadline = DateTime.UtcNow + window;
            var settle = TimeSpan.FromSeconds(10);

            while (DateTime.UtcNow < deadline)
            {
                var result = _consumer.Consume(TimeSpan.FromSeconds(2));
                if (result?.Message?.Value is { Length: > 0 } value)
                {
                    records.Add(JsonDocument.Parse(value).RootElement.Clone());

                    if (records.Count == 1)
                    {
                        deadline = DateTime.UtcNow + settle;
                    }
                }
            }

            return records;
        }

        public void Dispose()
        {
            _consumer.Close();
            _consumer.Dispose();
        }
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
    /// <param name="field">The attribute to scope the lineage by -- ExecutionId or CorrelationId.</param>
    /// <param name="value">The id to match.</param>
    /// <param name="mustContain">
    /// Text one returned line has to carry before the lineage counts as arrived.
    /// <para>
    /// <b>Polling until the result is merely NON-EMPTY is not enough, and this parameter is the
    /// fix.</b> A lineage lands in Elasticsearch a line at a time: the first query can return four
    /// of its lines while the one this test needs -- the importer's, the only line anywhere carrying
    /// the absolute path -- is still in flight. Returning on the first non-empty page then asserts
    /// against a half-indexed lineage and fails with the right id and the wrong lines. It was
    /// invisible while Drain read for a fixed ninety seconds, because that span happened to give the
    /// exporter enough slack; a drain that returns as soon as its record arrives took the slack away
    /// and left the bug.
    /// </para>
    /// </param>
    private static async Task<List<string>> LinesAsync(string field, string value, string? mustContain = null)
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
                var lines = hits.EnumerateArray()
                    .Select(h => h.GetProperty("_source").GetProperty("body").GetProperty("text").GetString() ?? "")
                    .ToList();

                if (mustContain is null
                    || lines.Exists(l => l.Contains(mustContain, StringComparison.Ordinal)))
                {
                    return lines;
                }
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
            // LISTENING FIRST. The chain answers in seconds, so a drain started after the produce
            // can be assigned its partition only after the record is already written -- see
            // FailureDrain.
            using var drain = FailureDrain.Start();

            await ProduceAsync(path);

            var records = drain.Collect(TimeSpan.FromMinutes(5));
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
            var byExecution = await LinesAsync("ExecutionId", executionId, path);
            Assert.Contains(byExecution, line => line.Contains(path, StringComparison.Ordinal));

            // RESOLUTION #2: by correlation id. For THIS failure it is redundant with #1, since a
            // mid-chain failure has both ids -- but AnEntryStepFailureProducesARecordWithNoLineage
            // shows a real failure that has ONLY a correlation id (Rent/Open happens before an
            // execution id is minted), so correlation-only resolution has to work independently of
            // execution-id resolution, not merely as a side effect of it.
            var byCorrelation = await LinesAsync("CorrelationId", correlationId, path);
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

        // SEEDS ITS OWN FAILURE, and that arrangement is the point rather than a convenience. This
        // test used to drain the topic and wait for a failure some human had arranged out of band,
        // so with nobody seeding it failed by default -- and a test that is red in the steady state
        // cannot report a regression, because the red is already there. TheRecordLeadsToTheFileThat
        // Failed in this same file always did it this way; this one now follows it.
        //
        // The D5 shape: an archive whose entries are not exactly one .wav + one .json pair, which
        // AcmeHandler.ValidateContent refuses. SeedArchive builds exactly that -- one a.csv entry
        // groups to 0 .wav and 0 .json -- and puts it where FileFetcher opens it.
        var name = $"midchain-{Guid.NewGuid():N}.zip";
        var path = SeedArchive(name);

        try
        {
            // LISTENING FIRST. The chain answers in seconds, so a drain started after the produce
            // can be assigned its partition only after the record is already written -- see
            // FailureDrain.
            using var drain = FailureDrain.Start();

            await ProduceAsync(path);

            var records = drain.Collect(TimeSpan.FromMinutes(5));

            var record = Assert.Single(records);

            // "N" -- 32 hex, no dashes -- which is the form Elasticsearch holds, and the reason the
            // query below matches at all.
            var correlation = record.GetProperty("correlationId").GetString()!;
            Assert.Equal(32, correlation.Length);
            Assert.DoesNotContain('-', correlation);

            // "D", dashed, and present because the step that failed had a lineage.
            Assert.True(record.TryGetProperty("executionId", out var executionId));
            var execution = executionId.GetString()!;
            Assert.True(Guid.TryParse(execution, out _));

            Assert.True(record.TryGetProperty("recordedAtUtc", out _));

            // The pointer resolves: the lineage it names ends in two WARN lines -- one from the
            // processor carrying the reason, one from the orchestrator routing the failure onward.
            //
            // CORRECTED FROM THE BRIEF: the brief expected "no successor accepts it", which is
            // StepOutcomeHandler's TERMINAL-step line -- logged only when a step has NO successor at
            // all. That was true before Task 6 wired the PreviousFailed edge; it is no longer true.
            // The normalizer step this test fails now HAS a successor (FailureRecorder), so its
            // outcome takes the other branch in the same method: "advancing {SuccessorCount}
            // successor(s) on a {Result} step". Asserting the brief's original text would assert the
            // wiring is ABSENT -- the opposite of what this test exists to prove.
            var warnings = await WarningsAsync("ExecutionId", execution);

            Assert.Contains(warnings, w => w.Contains("the author reported the step failed"));
            Assert.Contains(warnings, w => w.Contains("advancing 1 successor(s) on a Failed step"));
        }
        finally
        {
            // Unconditional: a seed left on the node fails the chain again on its next tick, every
            // 30s, forever -- whether or not the assertions above passed.
            Cleanup(path);
        }
    }

    [Fact]
    public async Task AnEntryStepFailureProducesARecordWithNoLineage()
    {
        // GATED BEHIND THE SECOND SWITCH, and not because it is slow. This test BREAKS the live
        // chain: it repoints the entry step at a topic nothing publishes to, and until it is put
        // back the chain fails on every fire, twice a minute. The finally below restores it on every
        // ordinary path -- including a failed assertion -- but a killed process runs no finally, and
        // what it leaves behind is a cluster that looks broken with nothing pointing at the cause.
        //
        // That is exactly the hazard Chaos exists to require consent for: someone exporting
        // SKP_REALSTACK=1 is asking to READ the cluster, not to take a step of it down. Same
        // reasoning as Chaos.SkipUnlessEnabled, different sentence, because this breaks an
        // assignment rather than pausing Redis or scaling a StatefulSet.
        Assert.SkipUnless(Chaos.Enabled,
            "set SKP_REALSTACK=1 and SKP_CHAOS=1 to run this one; it repoints the live KafkaImporter "
            + "assignment at a topic nothing publishes to, and the chain fails on every fire until "
            + "it is restored");

        // Self-driving, for the reason AMidChainFailureProducesARecordNamingItsLineage now gives:
        // a test that waits for a situation a human was supposed to arrange is red whenever nobody
        // arranged it, and a permanently red test reports nothing.
        // LISTENING FIRST, for the reason FailureDrain gives: the break below fails the very next
        // fire, and a drain started afterwards would be assigned its partition too late to see it.
        using var drain = FailureDrain.Start();

        var (assignment, row) = await ImporterAssignmentAsync();
        var original = row.GetProperty("payload").GetString()!;

        // Only the topic moves. Restoring the payload this test READ, rather than one it composed,
        // is what keeps a restore from quietly rewriting messageCount or the consumer group.
        await PutPayloadAsync(assignment, row, WithTopic(original, "skp-nothing-publishes-here"));

        try
        {
            // RE-PROJECTED, and without this the test quietly proves nothing. A running workflow
            // reads its assignments from the L2 projection written when it STARTED, not from the row
            // -- so editing the row alone leaves the importer happily consuming skp-paths, and the
            // drain below times out against a chain that never failed. Measured: the importer logged
            // "consumed 0/25 records; stopped because Drained" throughout, never once naming the
            // broken topic. Stop/start is what republishes the projection.
            await RestartWorkflowAsync();

            // Open returns false within the idle timeout and the step fails before opening any
            // lineage.
            var records = drain.Collect(TimeSpan.FromMinutes(5));

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
        finally
        {
            // Unconditional, and the whole reason the break above is safe to perform from a test:
            // the assignment goes back to the payload this test read, whether the assertions passed,
            // failed, or threw. A broken entry step fails every fire until it is put back.
            await PutPayloadAsync(assignment, row, original);

            // And the projection with it -- restoring the row alone would leave the RUNNING workflow
            // still importing from the broken topic, which is the same trap the break above had to
            // work around, in the direction that matters more.
            await RestartWorkflowAsync();
        }
    }

    /// <summary>The chain this class fails on purpose.</summary>
    private static string ChainWorkflowId =>
        RealStack.Get("SKP_CHAIN_WORKFLOW_ID", "1a56b3ca-e276-4815-87fa-5c2f48ab6dad");

    /// <summary>
    /// Stops and starts the chain, which is how an assignment edit reaches a RUNNING workflow: the
    /// orchestrator projects assignments into L2 at start and reads them from there afterwards.
    /// </summary>
    private static async Task RestartWorkflowAsync()
    {
        using var http = new HttpClient { BaseAddress = new Uri(RealStack.BaseApiUrl) };

        foreach (var verb in new[] { "stop", "start" })
        {
            var response = await http.PostAsync(
                $"/api/v1/orchestration/{verb}",
                new StringContent($"\"{ChainWorkflowId}\"", Encoding.UTF8, "application/json"));

            Assert.True(response.IsSuccessStatusCode,
                $"POST /api/v1/orchestration/{verb} returned {(int)response.StatusCode}");
        }

        // 202 means accepted, not applied -- the projection write is handed to a durable queue. The
        // drain that follows has minutes of slack, so a short settle is enough to keep the next fire
        // from reading a half-written projection.
        await Task.Delay(TimeSpan.FromSeconds(5));
    }

    /// <summary>The entry step whose assignment names the topic the chain imports from.</summary>
    private static string ImporterStepId =>
        RealStack.Get("SKP_IMPORTER_STEP_ID", "ab9d8741-c109-4457-a090-d76e1ca64a97");

    /// <summary>
    /// The importer's assignment row, found by the step it is attached to rather than by a recorded
    /// id -- an id would go stale the first time the chain is rebuilt, and this file would then break
    /// an assignment belonging to something else.
    /// </summary>
    private static async Task<(string Id, JsonElement Row)> ImporterAssignmentAsync()
    {
        using var http = new HttpClient { BaseAddress = new Uri(RealStack.BaseApiUrl) };
        using var all = JsonDocument.Parse(await http.GetStringAsync("/api/v1/assignments"));

        var row = all.RootElement.EnumerateArray()
            .Single(a => a.GetProperty("stepId").GetString() == ImporterStepId);

        // Cloned: the document is disposed at the end of this method and an un-cloned element dies
        // with it.
        return (row.GetProperty("id").GetString()!, row.Clone());
    }

    /// <summary>
    /// The same payload with a different topic. Rewriting one field rather than composing a whole
    /// payload is what lets the restore put back a messageCount and consumer group this test never
    /// had to know.
    /// </summary>
    private static string WithTopic(string payload, string topic)
    {
        var fields = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(payload)!;
        fields["topic"] = JsonSerializer.SerializeToElement(topic);
        return JsonSerializer.Serialize(fields);
    }

    /// <summary>PUTs the row back with a different payload, and asserts the API accepted it.</summary>
    private static async Task PutPayloadAsync(string id, JsonElement row, string payload)
    {
        using var http = new HttpClient { BaseAddress = new Uri(RealStack.BaseApiUrl) };

        var body = JsonSerializer.Serialize(new
        {
            name = row.GetProperty("name").GetString(),
            version = row.GetProperty("version").GetString(),
            description = row.TryGetProperty("description", out var d) ? d.GetString() : null,
            stepId = row.GetProperty("stepId").GetString(),
            payload,
        });

        var response = await http.PutAsync(
            $"/api/v1/assignments/{id}", new StringContent(body, Encoding.UTF8, "application/json"));

        // Asserted rather than ignored: a restore that silently 400s leaves the chain broken, and
        // the next person to look would see a failing cluster and a passing test run.
        Assert.True(response.IsSuccessStatusCode,
            $"PUT /api/v1/assignments/{id} returned {(int)response.StatusCode}");
    }
}
