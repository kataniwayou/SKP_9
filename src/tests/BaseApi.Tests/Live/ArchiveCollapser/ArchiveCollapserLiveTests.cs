using System.Diagnostics;
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
    /// A NEW topic, not <see cref="RealStack.KafkaTopic"/>: that one feeds the existing
    /// FileFetcher/ArchiveExpander workflow, whose first step expects <c>{"filePath": ...}</c>, not
    /// a FileNode document. ArchiveCollapser's workflow is its own, wired independently by an
    /// operator the same way that one was — see <c>k8s/README.md</c>.
    /// </para>
    /// </summary>
    private static string InTopic => RealStack.Get("SKP_ARCHIVECOLLAPSER_IN_TOPIC", "skp-archivecollapser-in");

    /// <summary>The topic that workflow's KafkaExporter step publishes ArchiveCollapser's envelope to.</summary>
    private static string OutTopic => RealStack.Get("SKP_ARCHIVECOLLAPSER_OUT_TOPIC", "skp-archivecollapser-out");

    /// <summary>The deployment whose logs carry the processor's own messages.</summary>
    private static string Deployment => RealStack.Get("SKP_ARCHIVECOLLAPSER_DEPLOYMENT", "processor-archivecollapser");

    private static string Namespace => RealStack.Get("SKP_NAMESPACE", "skp");

    /// <summary>
    /// A <c>{metadata, content}</c> document with two leaf entries under one zip-named root, built by
    /// hand rather than through <c>Processor.ArchiveCollapser</c>'s own <c>FileNode</c>/
    /// <c>FileNodeConverter</c> types: this suite talks to the pod only at the wire boundary, the
    /// same way <see cref="ArchiveExpander.ArchiveExpanderLiveTests"/> never references
    /// ArchiveExpander's own <c>FileNode</c> to build the record it produces. <c>byte[]</c> renders
    /// as base64 by default, which is the same wire form <c>FileContent.Bytes</c> writes.
    /// </summary>
    private static string Document(string name)
    {
        object Leaf(string fileName, string text) => new
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

    [Fact]
    public async Task ADocumentOnTheInTopicBecomesAnEnvelopeOnTheOutTopic()
    {
        RealStack.SkipUnlessEnabled();

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
}
