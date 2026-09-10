using System.Diagnostics;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Text.Json;
using Confluent.Kafka;
using Processor.ArchiveExpander.Extractors;
using Xunit;

namespace BaseApi.Tests.Live.ArchiveCollapser;

/// <summary>
/// The half of ArchiveCollapser that only the cluster can answer: a <c>{metadata, content}</c>
/// document really reaches the pod over Kafka and RabbitMQ, and comes out the far side as a raw-file
/// envelope on a real out topic, with the processor's own log line landing in a real log store.
/// Everything in the hermetic <c>ProcessorArchiveCollapserTests</c> suite runs against an in-process
/// processor handed a document directly, which is what keeps that run cluster-free — but it also
/// means the manifest's wiring, the RabbitMQ hop, and the workflow's own entry conditions have no
/// test above them. This file is that test.
/// <para>
/// <b>Deliberately NOT a <c>TheOutputSchemaRowIsRegistered</c> test.</b> Phase 1 registers every
/// schema id null (see the ArchiveCollapser design, section 1.1), the same reason
/// <see cref="ArchiveExpander.ArchiveExpanderLiveTests.TheOutputSchemaRowIsRegistered"/> and
/// <see cref="FileFetcher.FileFetcherLiveTests.TheOutputSchemaRowIsRegistered"/> are gated below.
/// Adding a third instance of that assertion here would only be a third red test for the same
/// design decision — it belongs to phase 2, Task 12, which registers the rows.
/// </para>
/// <para>
/// Needs <c>SKP_REALSTACK=1</c>, <c>k8s/port-forward-realstack.ps1</c> and
/// <c>tools/kafka-dev-broker.ps1 -Up</c>, plus a workflow an operator has wired as
/// <c>KafkaImporter → ArchiveCollapser → KafkaExporter</c> on the topics named by
/// <see cref="InTopic"/> and <see cref="OutTopic"/>. ArchiveCollapser has no volume mount and no
/// path of its own to seed — its input IS the document, published directly, which is why this suite
/// has no <c>docker cp</c> step the FileFetcher/ArchiveExpander suites need.
/// </para>
/// </summary>
/// <remarks>
/// Shares the <c>kafka-broker</c> collection with <see cref="KafkaImporterLiveTests"/>,
/// <see cref="KafkaExporterLiveTests"/>, <see cref="ArchiveExpander.ArchiveExpanderLiveTests"/> and
/// <see cref="FileFetcher.FileFetcherLiveTests"/>, which stop and start the shared dev Kafka
/// container. Without the collection, xunit's default parallelism (<c>maxParallelThreads: 6</c> in
/// <c>xunit.runner.json</c>) could run this class while the broker is down, producing a flaky
/// failure that looks like an ArchiveCollapser bug instead of the borrowed-infrastructure race it
/// is.
/// </remarks>
[Trait("Category", RealStack.Category)]
[Collection("kafka-broker")]
public sealed class ArchiveCollapserLiveTests
{
    private static readonly DateTime Stamp = new(2026, 6, 7, 8, 9, 10, DateTimeKind.Utc);

    private static readonly JsonSerializerOptions DocumentOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    /// <summary>
    /// The topic a workflow's KafkaImporter step is wired to drain straight into ArchiveCollapser.
    /// <para>
    /// <b>No default, on purpose — unset means no such workflow exists.</b> A NEW topic, not
    /// <see cref="RealStack.KafkaTopic"/>: that one feeds the existing FileFetcher/ArchiveExpander
    /// workflow, whose first step expects <c>{"filePath": ...}</c>, not a FileNode document.
    /// Nothing in this repo provisions a topic for ArchiveCollapser's own workflow — an operator
    /// must wire <c>KafkaImporter → ArchiveCollapser → KafkaExporter</c> and name its topics here,
    /// the same way <c>SKP_FILEREADER_DEEP_TOPIC</c> names a second FileFetcher/ArchiveExpander
    /// workflow nobody is obliged to have wired. Defaulting to a concrete name instead of empty
    /// would let a run against a topic nothing provisions either burn the whole window on
    /// <c>Assert.True(envelope.HasValue, ...)</c> or throw <c>UnknownTopicOrPart</c> out of
    /// <see cref="ProduceAsync"/> — both read as an ArchiveCollapser defect rather than what they
    /// actually are, "no workflow is wired". See <c>k8s/README.md</c>.
    /// </para>
    /// </summary>
    private static string InTopic => RealStack.Get("SKP_ARCHIVECOLLAPSER_IN_TOPIC", "");

    /// <summary>
    /// The topic that workflow's KafkaExporter step publishes ArchiveCollapser's envelope to.
    /// No default, for the same reason as <see cref="InTopic"/>.
    /// </summary>
    private static string OutTopic => RealStack.Get("SKP_ARCHIVECOLLAPSER_OUT_TOPIC", "");

    /// <summary>The deployment whose logs carry the processor's own messages.</summary>
    private static string Deployment => RealStack.Get("SKP_ARCHIVECOLLAPSER_DEPLOYMENT", "processor-archivecollapser");

    private static string Namespace => RealStack.Get("SKP_NAMESPACE", "skp");

    /// <summary>
    /// A leaf node — bytes, never entries — shared by <see cref="Document"/> and
    /// <see cref="UnpackableDocument"/>. <c>byte[]</c> renders as base64 by default, which is the
    /// same wire form <c>FileContent.Bytes</c> writes.
    /// </summary>
    private static object Leaf(string fileName, string text) => new
    {
        metadata = new
        {
            name = fileName,
            extension = Path.GetExtension(fileName),
            sizeBytes = (long)Encoding.UTF8.GetByteCount(text),
            createdUtc = (DateTime?)null,
            modifiedUtc = Stamp,
            entryCount = 0,
        },
        content = Encoding.UTF8.GetBytes(text),
    };

    /// <summary>
    /// A <c>{metadata, content}</c> document with two leaf entries under one zip-named root, built by
    /// hand rather than through <c>Processor.ArchiveCollapser</c>'s own <c>FileNode</c>/
    /// <c>FileNodeConverter</c> types: this suite talks to the pod only at the wire boundary, the
    /// same way <see cref="ArchiveExpander.ArchiveExpanderLiveTests"/> never references
    /// ArchiveExpander's own <c>FileNode</c> to build the record it produces.
    /// </summary>
    private static string Document(string name)
    {
        var root = new
        {
            metadata = new
            {
                name,
                extension = ".zip",
                // Deliberately wrong, the same way the hermetic suite's
                // TheLoggedEntryCountAndDepthComeFromContentNotTheDeclaredMetadata pins it: the
                // logged entry count must come from the content array (2), never this declared 99,
                // so a reader who swapped the two would be caught by the log assertion below.
                sizeBytes = 0L,
                createdUtc = (DateTime?)null,
                modifiedUtc = Stamp,
                entryCount = 99,
            },
            content = new object[] { Leaf("a.csv", "id\n"), Leaf("b.csv", "id,name\n") },
        };

        return JsonSerializer.Serialize(root, DocumentOptions);
    }

    /// <summary>
    /// A document that cannot be packed: the root carries entries — content says "I am an
    /// archive" — but its extension is <c>.csv</c>, which names no writer. <c>ArchiveBuilder.Match</c>
    /// returns null, <c>Pack</c> throws <c>ArchiveWritingException</c> before any child is built, and
    /// <c>ArchiveCollapserProcessor</c> wraps that into
    /// <c>collapsing {FileName} failed: ...</c> — a <c>FailedException</c> path: reported, acked,
    /// terminal. The mirror of the hermetic
    /// <c>ProcessorArchiveCollapserTests.AnUnpackableNodeFailsOnTheCollapsingTemplate</c>, but here
    /// what only the cluster can show is that this is the path taken — a
    /// <c>NullReferenceException</c> from a programming error would instead surface as a stack
    /// trace and no failed-step log line, and no hermetic test can tell the two apart.
    /// </summary>
    private static string UnpackableDocument(string name)
    {
        var root = new
        {
            metadata = new
            {
                name,
                extension = ".csv",
                sizeBytes = 0L,
                createdUtc = (DateTime?)null,
                modifiedUtc = Stamp,
                entryCount = 1,
            },
            content = new object[] { Leaf("a.csv", "id\n") },
        };

        return JsonSerializer.Serialize(root, DocumentOptions);
    }

    /// <summary>
    /// Produces with <c>ProduceAsync</c> and checks the delivery report, not <c>Produce</c> plus
    /// <c>Flush</c>: flush only proves the local queue drained, which stays silent whether the
    /// broker accepted the record or rejected it.
    /// </summary>
    private static async Task ProduceAsync(string json)
    {
        using var producer = new ProducerBuilder<Null, string>(
            new ProducerConfig { BootstrapServers = RealStack.KafkaBrokers }).Build();

        var result = await producer.ProduceAsync(InTopic, new Message<Null, string> { Value = json });

        Assert.True(result.Status == PersistenceStatus.Persisted,
            $"produce to {InTopic} did not persist: status was {result.Status}");
    }

    /// <summary>The first envelope on the out topic whose fileName matches, or null on timeout.</summary>
    private static JsonElement? Await(string name, TimeSpan timeout)
    {
        using var consumer = new ConsumerBuilder<Ignore, string>(new ConsumerConfig
        {
            BootstrapServers = RealStack.KafkaBrokers,
            GroupId = $"live-archivecollapser-{Guid.NewGuid():N}",
            AutoOffsetReset = AutoOffsetReset.Earliest,
        }).Build();

        consumer.Subscribe(OutTopic);

        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            var result = consumer.Consume(TimeSpan.FromSeconds(5));
            if (result?.Message?.Value is null)
            {
                continue;
            }

            var root = JsonDocument.Parse(result.Message.Value).RootElement;
            if (root.TryGetProperty("fileName", out var fileName) && fileName.GetString() == name)
            {
                return root.Clone();
            }
        }

        return null;
    }

    /// <summary>
    /// Runs a command and returns its stdout.
    /// <para>
    /// Drains stdout before waiting on exit — <c>ReadToEnd</c> before <c>WaitForExit</c>, in that
    /// order, since a full pipe blocks the child and waiting first would deadlock on any output
    /// larger than the buffer. <c>kubectl logs</c> is exactly that chatty.
    /// </para>
    /// </summary>
    private static string Capture(string file, string arguments)
    {
        using var process = Process.Start(new ProcessStartInfo(file, arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        })!;

        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();

        if (!process.WaitForExit(60_000))
        {
            process.Kill(entireProcessTree: true);
            Assert.Fail($"{file} {arguments} did not exit within 60s and was killed");
        }

        Assert.True(process.ExitCode == 0, $"{file} {arguments} exited {process.ExitCode}: {stderr}");
        return stdout;
    }

    /// <summary>
    /// The processor's recent log lines, across every replica of the deployment.
    /// <para>
    /// <c>--prefix</c> so a line can be attributed to a pod, and a generous <c>--tail</c> because the
    /// probe traffic this deployment logs is heavy enough to push a step's own line out of a short
    /// window.
    /// </para>
    /// </summary>
    private static string PodLog(TimeSpan since)
        => Capture("kubectl",
            $"logs -n {Namespace} deployment/{Deployment} --all-containers --prefix "
            + $"--since={(int)since.TotalSeconds}s --tail=2000");

    /// <summary>
    /// THE ONE WINDOW every assertion in this class waits on, positive and negative alike — the same
    /// invariant <see cref="ArchiveExpander.ArchiveExpanderLiveTests.Window"/> and
    /// <see cref="FileFetcher.FileFetcherLiveTests.Window"/> state for their own suites, established
    /// by commit <c>f084bfc</c>: one field rather than a repeated literal, and five minutes rather
    /// than two, because the live tests run concurrently (xunit <c>maxParallelThreads: 6</c>) against
    /// shared infrastructure and the work serialises under that load. Do not reintroduce a
    /// per-assertion timeout here.
    /// </summary>
    private static readonly TimeSpan Window = TimeSpan.FromMinutes(5);

    /// <summary>
    /// Polls the log until it contains <paramref name="needle"/>, or the deadline passes.
    /// <para>
    /// Polled rather than read once: the envelope reaching Kafka and the line reaching the log store
    /// are not ordered, so a single read straight after the assertion on the topic is a race that
    /// fails intermittently and looks like a missing log line.
    /// </para>
    /// </summary>
    private static bool LogContains(string needle, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        var window = timeout + TimeSpan.FromMinutes(1);

        while (DateTime.UtcNow < deadline)
        {
            if (PodLog(window).Contains(needle, StringComparison.Ordinal))
            {
                return true;
            }

            Thread.Sleep(5_000);
        }

        return false;
    }

    /// <summary>
    /// Both topic vars must be set, together — an in topic with no out topic (or the reverse) is
    /// still no usable workflow. Same shape as
    /// <c>ArchiveExpanderLiveTests.ADocumentDeeperThanTheSchemaFailsAndLogsTheDepth</c>'s
    /// <c>Assert.SkipWhen(DeepTopic.Length == 0, ...)</c>: a workflow nobody has wired defaults to
    /// absent, and the test skips naming exactly what to set rather than failing confusingly
    /// against a topic nothing backs.
    /// </summary>
    private static void SkipUnlessWorkflowTopicsAreSet() =>
        Assert.SkipWhen(InTopic.Length == 0 || OutTopic.Length == 0,
            "set SKP_ARCHIVECOLLAPSER_IN_TOPIC and SKP_ARCHIVECOLLAPSER_OUT_TOPIC to the topics of "
            + "a workflow wired KafkaImporter -> ArchiveCollapser -> KafkaExporter; nothing in this "
            + "repo provisions them, so they default to empty rather than a name nothing backs");

    [Fact]
    public async Task ADocumentOnTheInTopicBecomesAnEnvelopeOnTheOutTopic()
    {
        RealStack.SkipUnlessEnabled();
        SkipUnlessWorkflowTopicsAreSet();

        // THE WHOLE CHAIN: a document published to the in topic reaches ArchiveCollapser through
        // the wired workflow's KafkaImporter step, crosses RabbitMQ to the pod, and comes out the
        // far side as a raw-file envelope on the exporter's out topic. No hermetic suite can prove
        // this — ProcessorArchiveCollapserTests hands the processor a document in-process, which is
        // what keeps it cluster-free but also what leaves the manifest, the wiring and the RabbitMQ
        // hop with no test above them.
        var name = $"orders-{Guid.NewGuid():N}.zip";
        await ProduceAsync(Document(name));

        var envelope = Await(name, Window);
        Assert.True(envelope.HasValue,
            $"no envelope naming {name} reached {OutTopic} within {Window.TotalMinutes:0} minutes");

        var root = envelope!.Value;
        Assert.Equal(".zip", root.GetProperty("extension").GetString());

        // The raw-file proof: not just base64 that decodes, but base64 a REAL zip extractor can
        // open and that names exactly the two entries the input document declared — the same check
        // ProcessorArchiveCollapserTests.AnArchiveDocumentProducesAnArchiveTheRealExtractorCanOpen
        // makes in-process, made here against what the cluster actually produced.
        var content = root.GetProperty("content").GetBytesFromBase64();
        using var stream = new MemoryStream(content, writable: false);
        Assert.Equal(
            ["a.csv", "b.csv"],
            new ZipExtractor().Extract(stream).Select(e => e.Name).ToArray());

        // The log line, and the entry count within it: 2, from the content array, never the
        // document's declared (and deliberately wrong) 99. "collapsed {FileName} of {EntryCount}
        // entries into {SizeBytes} bytes, from depth {DepthReached}" is the exact template in
        // ArchiveCollapserProcessor — check the source before trusting this comment if it changes.
        Assert.True(
            LogContains($"collapsed {name} of 2 entries into", Window),
            $"no 'collapsed {name} of 2 entries into ...' line reached the ArchiveCollapser log "
            + $"within {Window.TotalMinutes:0} minutes");
    }

    [Fact]
    public async Task AnUnpackableDocumentProducesNoEnvelopeAndLogsTheFailure()
    {
        RealStack.SkipUnlessEnabled();
        SkipUnlessWorkflowTopicsAreSet();

        // THE SPLIT INVISIBLE IN-PROCESS. A FailedException from ArchiveWritingException is
        // reported, acked and terminal -- the framework's general catch instead logs a stack trace
        // with no diagnosable line. ProcessorArchiveCollapserTests.AnUnpackableNodeFailsOnTheCollapsingTemplate
        // already proves the message text; what only the cluster can show is that a real dispatch
        // through RabbitMQ takes the FailedException path rather than the general one, and that the
        // failed step never reaches the out topic.
        var name = $"orders-{Guid.NewGuid():N}.csv";
        await ProduceAsync(UnpackableDocument(name));

        Assert.Null(Await(name, Window));

        Assert.True(
            LogContains($"collapsing {name} failed:", Window),
            $"the step failed but no 'collapsing {name} failed:' line reached the ArchiveCollapser "
            + $"log within {Window.TotalMinutes:0} minutes");
    }

    // ---------------------------------------------------------------------------------------
    // The two schema-row tests. Phase 1 registered every schema id null, so these were gated;
    // Task 12 registers the two shared rows and re-arms them, here and on the two upstream
    // processors (ArchiveExpanderLiveTests.TheOutputSchemaRowIsRegistered and
    // FileFetcherLiveTests.TheOutputSchemaRowIsRegistered).
    // ---------------------------------------------------------------------------------------

    /// <summary>
    /// This build's source hash for ArchiveCollapser, read from the assembly rather than pasted in
    /// — see <see cref="ArchiveExpander.ArchiveExpanderLiveTests.SourceHash"/> for why: a literal
    /// here would be stale by the next commit and would fail as a missing processor row, which
    /// reads like a deployment fault rather than a stale constant.
    /// </summary>
    private static string CollapserSourceHash
        => typeof(global::Processor.ArchiveCollapser.FileNode).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .Single(a => a.Key == "SourceHash").Value!;

    /// <summary>
    /// This build's source hash for ArchiveExpander, needed only by
    /// <see cref="TheCollapserInputIdEqualsTheExpanderOutputId"/> — fully qualified rather than
    /// pulled in with a <c>using</c>, since both processor assemblies declare their own
    /// <c>FileNode</c> and this file already references ArchiveExpander's <c>Extractors</c>
    /// namespace.
    /// </summary>
    private static string ExpanderSourceHash
        => typeof(global::Processor.ArchiveExpander.FileNode).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .Single(a => a.Key == "SourceHash").Value!;

    private sealed record ProcessorRow(Guid? InputSchemaId, Guid? OutputSchemaId);

    /// <summary>
    /// Fetches a processor row by source hash, copying the query shape of
    /// <see cref="ArchiveExpander.ArchiveExpanderLiveTests.TheOutputSchemaRowIsRegistered"/> exactly:
    /// a plain <c>GetAsync</c> against <c>/api/v1/processors/by-source-hash/{sourceHash}</c> on
    /// <see cref="RealStack.BaseApiUrl"/>, with a null return (rather than throwing) standing in for
    /// the non-success status that method inlines, so both tests below can report which processor's
    /// row was missing.
    /// </summary>
    private static async Task<ProcessorRow?> GetProcessorRowAsync(string sourceHash, CancellationToken ct)
    {
        using var client = new HttpClient { BaseAddress = new Uri(RealStack.BaseApiUrl) };

        var response = await client.GetAsync($"/api/v1/processors/by-source-hash/{sourceHash}", ct);
        if (!response.IsSuccessStatusCode)
        {
            return null;
        }

        var row = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct)).RootElement;

        Guid? SchemaId(string property) =>
            row.TryGetProperty(property, out var value) && value.ValueKind != JsonValueKind.Null
                ? value.GetGuid()
                : null;

        return new ProcessorRow(SchemaId("inputSchemaId"), SchemaId("outputSchemaId"));
    }

    [Fact]
    public async Task TheSchemaRowsAreRegistered()
    {
        RealStack.SkipUnlessEnabled();

        // Proves this build's half landed. No row means the image was rebuilt without repointing
        // the source hash; a null id means the schema was never registered, and with a null
        // TryValidate returns true without decoding anything -- so a document arriving downstream
        // would prove only that a document was produced, never that it was validated.
        var row = await GetProcessorRowAsync(
            CollapserSourceHash, TestContext.Current.CancellationToken);

        Assert.True(row is not null,
            $"no processor row for source hash {CollapserSourceHash} — the image was rebuilt "
            + "without repointing the row, or the row was never registered");

        Assert.True(row!.InputSchemaId is not null,
            "the processor row exists but InputSchemaId is null — the tree schema from "
            + "src/tests/BaseApi.Tests/Schemas/tree.json has not been registered");

        Assert.True(row.OutputSchemaId is not null,
            "the processor row exists but OutputSchemaId is null — the envelope schema from "
            + "src/tests/BaseApi.Tests/Schemas/envelope.json has not been registered");
    }

    [Fact]
    public async Task TheCollapserInputIdEqualsTheExpanderOutputId()
    {
        RealStack.SkipUnlessEnabled();

        // THE EDGE, and the only assertion that catches the two rows drifting apart. Byte-identical
        // definitions are not enough -- SchemaEdgeValidator
        // (BaseApi.Service/Features/Orchestration/Validation/SchemaEdgeValidator.cs) compares
        // schema IDS, not definitions, so two rows holding the same JSON text under two different
        // ids are still an unwireable edge: publishing a workflow across them throws a 422 naming
        // the pair.
        var expander = await GetProcessorRowAsync(
            ExpanderSourceHash, TestContext.Current.CancellationToken);
        var collapser = await GetProcessorRowAsync(
            CollapserSourceHash, TestContext.Current.CancellationToken);

        Assert.True(expander is not null,
            $"no processor row for archive-expander's source hash {ExpanderSourceHash}");
        Assert.True(collapser is not null,
            $"no processor row for archive-collapser's source hash {CollapserSourceHash}");

        Assert.Equal(expander!.OutputSchemaId, collapser!.InputSchemaId);
    }
}
