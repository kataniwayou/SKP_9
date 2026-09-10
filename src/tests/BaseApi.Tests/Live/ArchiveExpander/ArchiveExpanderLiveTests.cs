using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http;
using System.Reflection;
using System.Text.Json;
using Confluent.Kafka;
using Processor.ArchiveExpander;
using Xunit;

namespace BaseApi.Tests.Live.ArchiveExpander;

/// <summary>
/// The half of the FileFetcher → ArchiveExpander chain that only the cluster can answer once a file
/// has already been fetched: the end-to-end document on the exporter's out topic, the registered
/// output schema, and ArchiveExpander's own depth logic and failure log line. Everything in the
/// hermetic ArchiveExpander suite runs against an in-process processor handed an envelope directly,
/// which is what keeps that run cluster-free — but it also means the registered schema row, the
/// manifest's wiring, and the two entry conditions downstream of a real fetch have no test above
/// them. This file is that test.
/// <para>
/// Needs <c>SKP_REALSTACK=1</c>, <c>k8s/port-forward-realstack.ps1</c> and
/// <c>tools/kafka-dev-broker.ps1 -Up</c>. Every test here still seeds a file onto the kind node with
/// <c>docker cp</c> — FileFetcher is the only entry point into this workflow, so there is no way to
/// hand ArchiveExpander an envelope without going through it — but the assertions below are about
/// what ArchiveExpander itself does with that envelope, not about the mount. See
/// <see cref="BaseApi.Tests.Live.FileFetcher.FileFetcherLiveTests"/> for the tests that assert on the
/// mount, the seeding, and FileFetcher's own log line.
/// </para>
/// </summary>
/// <remarks>
/// Shares the <c>kafka-broker</c> collection with <see cref="KafkaImporterLiveTests"/>,
/// <see cref="KafkaExporterLiveTests"/> and
/// <see cref="BaseApi.Tests.Live.FileFetcher.FileFetcherLiveTests"/>, which stop and start the shared
/// dev Kafka container. Without the collection, xunit's default parallelism
/// (<c>maxParallelThreads: 6</c> in <c>xunit.runner.json</c>) could run this class while the broker
/// is down, producing a flaky failure that looks like an ArchiveExpander bug instead of the
/// borrowed-infrastructure race it is.
/// </remarks>
[Trait("Category", RealStack.Category)]
[Collection("kafka-broker")]
public sealed class ArchiveExpanderLiveTests
{
    private const string NodeDir = "/mnt/skp-files/in";
    private static string Node => RealStack.Get("SKP_KIND_NODE", "desktop-control-plane");
    private static string OutTopic => RealStack.Get("SKP_KAFKA_OUT_TOPIC", "skp-documents");

    /// <summary>Builds a zip locally and copies it onto the node the FileFetcher pod mounts.</summary>
    private static string SeedZip(string name, params (string Entry, string Text)[] entries)
    {
        var local = Path.Combine(Path.GetTempPath(), name);
        using (var file = File.Create(local))
        using (var archive = new ZipArchive(file, ZipArchiveMode.Create))
        {
            foreach (var (entry, text) in entries)
            {
                using var writer = new StreamWriter(archive.CreateEntry(entry).Open());
                writer.Write(text);
            }
        }

        Run("docker", $"cp \"{local}\" {Node}:{NodeDir}/{name}");
        return $"{NodeDir}/{name}";
    }

    /// <summary>
    /// Runs a command and waits for it to exit, on purpose not with the void overload of
    /// <c>WaitForExit</c>: that one blocks forever on a wedged child, and reading
    /// <see cref="Process.ExitCode"/> after a timed-out bool overload throws
    /// <c>InvalidOperationException("process has not exited")</c> — an unrelated crash standing in
    /// for the diagnosable failure this method exists to report.
    /// <para>
    /// On timeout the child is killed rather than left running: a <c>using</c> block only disposes
    /// the process handle, not the process itself, and an orphaned child here is not theoretical —
    /// this repo has already lost a run to a background process that outlived it and corrupted a
    /// later test's results.
    /// </para>
    /// </summary>
    private static void Run(string file, string arguments)
    {
        using var process = Process.Start(new ProcessStartInfo(file, arguments)
        {
            RedirectStandardError = true,
            // Not redirecting stdout: nothing here reads it, and a redirected pipe nobody drains
            // is a deadlock waiting for whichever command turns out to be chatty. `docker cp` is
            // quiet today, which is exactly the kind of assumption that stops being true silently.
        })!;

        if (!process.WaitForExit(60_000))
        {
            process.Kill(entireProcessTree: true);
            Assert.Fail($"{file} {arguments} did not exit within 60s and was killed");
        }

        Assert.True(process.ExitCode == 0,
            $"{file} {arguments} exited {process.ExitCode}: {process.StandardError.ReadToEnd()}");
    }

    /// <summary>
    /// Produces with <c>ProduceAsync</c> and checks the delivery report, not <c>Produce</c> plus
    /// <c>Flush</c>: flush only proves the local queue drained, which stays silent whether the
    /// broker accepted the record or rejected it.
    /// </summary>
    private static async Task ProduceAsync(string path)
    {
        using var producer = new ProducerBuilder<Null, string>(
            new ProducerConfig { BootstrapServers = RealStack.KafkaBrokers }).Build();

        var result = await producer.ProduceAsync(RealStack.KafkaTopic, new Message<Null, string>
        {
            // providerName rides along exactly as the org's records carry it, and the reader must
            // ignore it. Its absence from the document below is the assertion.
            Value = JsonSerializer.Serialize(new { filePath = path, providerName = "acme-feed" }),
        });

        Assert.True(result.Status == PersistenceStatus.Persisted,
            $"produce to {RealStack.KafkaTopic} did not persist: status was {result.Status}");
    }

    /// <summary>The first document on the out topic whose root name matches, or null on timeout.</summary>
    private static JsonElement? Await(string name, TimeSpan timeout)
    {
        using var consumer = new ConsumerBuilder<Ignore, string>(new ConsumerConfig
        {
            BootstrapServers = RealStack.KafkaBrokers,
            GroupId = $"live-archiveexpander-{Guid.NewGuid():N}",
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
            if (root.TryGetProperty("metadata", out var metadata)
                && metadata.GetProperty("name").GetString() == name)
            {
                return root.Clone();
            }
        }

        return null;
    }

    [Fact]
    public async Task AZipOnTheNodeBecomesADocumentOnTheOutTopic()
    {
        RealStack.SkipUnlessEnabled();

        // THE WHOLE CHAIN: a zip seeded onto the node reaches FileFetcher through the mount, becomes
        // an envelope, crosses to ArchiveExpander, and comes out the far side as a document on the
        // exporter's out topic. This is what proves the mount, both pods' manifests, and every edge
        // in between are wired correctly together — no single hermetic suite can, because each one
        // replaces its own processor's neighbours with an in-process call.
        var name = $"orders-{Guid.NewGuid():N}.zip";
        var path = SeedZip(name, ("a.csv", "id\n"), ("b.csv", "id,name\n"));

        await ProduceAsync(path);

        var doc = Await(name, Window);
        Assert.True(doc.HasValue, $"no document naming {name} reached {OutTopic} within {Window.TotalMinutes:0} minutes");

        var root = doc!.Value;
        Assert.Equal(JsonValueKind.Array, root.GetProperty("content").ValueKind);
        Assert.Equal(2, root.GetProperty("metadata").GetProperty("entryCount").GetInt32());
        Assert.Equal(2, root.GetProperty("content").GetArrayLength());

        // The one field the reader is required to drop.
        Assert.DoesNotContain("acme", root.GetRawText(), StringComparison.OrdinalIgnoreCase);
    }

    // ---------------------------------------------------------------------------------------
    // Nested expansion, live. The hermetic suite proves the depth logic against an in-process
    // processor; what it cannot reach is the registered output schema, which exists only as a
    // database row in the cluster. Every assertion below is about something that row decides.
    // ---------------------------------------------------------------------------------------

    /// <summary>The deployment whose logs carry the processor's own messages.</summary>
    private static string Deployment => RealStack.Get("SKP_ARCHIVEEXPANDER_DEPLOYMENT", "processor-archiveexpander");

    private static string Namespace => RealStack.Get("SKP_NAMESPACE", "skp");

    /// <summary>
    /// The topic feeding a SECOND workflow whose ArchiveExpander step is wired <c>maxDepth: 2</c>.
    /// <para>
    /// <b>It is a separate workflow because depth is a step payload, not a message field.</b> One
    /// wired workflow has one payload, so a test cannot ask for a different depth by producing a
    /// different record — the depth is decided by the row an operator wrote. Unset by default, and
    /// the test that needs it skips with instructions rather than failing.
    /// </para>
    /// <para>
    /// <b>The variable keeps its FileReader-era name on purpose.</b> It is documented under
    /// <c>SKP_FILEREADER_DEEP_TOPIC</c> in <c>k8s/README.md</c>, and renaming it here would silently
    /// stop reading whatever value an operator already has set for that name.
    /// </para>
    /// </summary>
    private static string DeepTopic => RealStack.Get("SKP_FILEREADER_DEEP_TOPIC", "");

    /// <summary>
    /// This build's source hash, read from the assembly rather than pasted in.
    /// <para>
    /// <c>SourceHash.targets</c> emits it as an <c>AssemblyMetadata</c> attribute, and it changes on
    /// every source edit — a literal here would be stale by the next commit and would fail as a
    /// missing processor row, which reads like a deployment fault rather than a stale constant.
    /// </para>
    /// </summary>
    private static string SourceHash
        => typeof(FileNode).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .Single(a => a.Key == "SourceHash").Value!;

    /// <summary>A zip in memory, so one can be nested inside another.</summary>
    private static byte[] ZipOf(params (string Name, byte[] Content)[] entries)
    {
        using var buffer = new MemoryStream();
        using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (name, content) in entries)
            {
                using var stream = archive.CreateEntry(name).Open();
                stream.Write(content);
            }
        }

        return buffer.ToArray();
    }

    /// <summary>Copies arbitrary bytes onto the node under the mounted directory.</summary>
    private static string SeedBytes(string name, byte[] bytes)
    {
        var local = Path.Combine(Path.GetTempPath(), name);
        File.WriteAllBytes(local, bytes);
        Run("docker", $"cp \"{local}\" {Node}:{NodeDir}/{name}");
        return $"{NodeDir}/{name}";
    }

    /// <summary>
    /// Runs a command and returns its stdout.
    /// <para>
    /// Separate from <see cref="Run"/>, which deliberately does NOT redirect stdout because nothing
    /// drains it. This one drains it — <c>ReadToEnd</c> before <c>WaitForExit</c>, in that order,
    /// since a full pipe blocks the child and waiting first would deadlock on any output larger
    /// than the buffer. <c>kubectl logs</c> is exactly that chatty.
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
    /// THE ONE WINDOW every assertion in this class waits on, positive and negative alike.
    /// <para>
    /// <b>It is one field rather than a repeated literal because the negative assertions depend on
    /// matching the positive ones.</b> `Assert.Null(Await(...))` proves a document never arrives,
    /// and that only means anything if a document that WAS coming would have arrived inside the
    /// same window. Two different literals — a long positive wait and a short negative one — make
    /// "nothing arrived" indistinguishable from "nothing arrived yet", which is a false pass.
    /// </para>
    /// <para>
    /// <b>Five minutes, raised from two on 2026-09-10, because two was not enough.</b> The live
    /// tests run concurrently (xunit <c>maxParallelThreads: 6</c>) and all produce to the same
    /// topic; the importer drains a batch per cron tick and each processor takes one dispatch at a
    /// time, so the work serialises and the last file in a batch waits behind every other. Two
    /// tests failed on that alone — their log lines were present and correct, timestamped after the
    /// assertion had given up. This bounds the WHOLE pipeline under concurrent load, not one step.
    /// </para>
    /// </summary>
    private static readonly TimeSpan Window = TimeSpan.FromMinutes(5);

    /// <summary>
    /// Polls the log until it contains <paramref name="needle"/>, or the deadline passes.
    /// <para>
    /// Polled rather than read once: the document reaching Kafka and the line reaching the log store
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

    private static async Task ProduceToAsync(string topic, string path)
    {
        using var producer = new ProducerBuilder<Null, string>(
            new ProducerConfig { BootstrapServers = RealStack.KafkaBrokers }).Build();

        var result = await producer.ProduceAsync(topic, new Message<Null, string>
        {
            Value = JsonSerializer.Serialize(new { filePath = path, providerName = "acme-feed" }),
        });

        Assert.True(result.Status == PersistenceStatus.Persisted,
            $"produce to {topic} did not persist: status was {result.Status}");
    }

    [Fact(Skip = "Phase 1 registers every schema id null -- see the ArchiveCollapser design, " +
                 "section 1.1. Re-armed by phase 2, which registers the two schema rows.")]
    public async Task TheOutputSchemaRowIsRegistered()
    {
        RealStack.SkipUnlessEnabled();

        // THE TEST THAT MAKES THE OTHERS MEAN ANYTHING. With OutputSchemaId null, TryValidate
        // returns true without decoding a byte: the schema enforces nothing, and every other live
        // assertion here passes vacuously. A document arriving on the out topic is NOT evidence the
        // schema was applied — it is evidence a document was produced, which is a different claim.
        //
        // This is also one of the deploy steps, so a failure here names the step that was skipped
        // rather than surfacing later as an unexplained absence of enforcement. See
        // <see cref="BaseApi.Tests.Live.FileFetcher.FileFetcherLiveTests.TheOutputSchemaRowIsRegistered"/>
        // for the same guarantee on the fetcher's own output schema, one hop upstream.
        using var client = new HttpClient { BaseAddress = new Uri(RealStack.BaseApiUrl) };

        var response = await client.GetAsync(
            $"/api/v1/processors/by-source-hash/{SourceHash}", TestContext.Current.CancellationToken);

        Assert.True(response.IsSuccessStatusCode,
            $"no processor row for source hash {SourceHash} ({(int)response.StatusCode}) — the image "
            + "was rebuilt without repointing the row, or the row was never registered");

        var row = JsonDocument.Parse(
            await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken)).RootElement;

        Assert.True(
            row.TryGetProperty("outputSchemaId", out var schemaId)
            && schemaId.ValueKind != JsonValueKind.Null,
            "the processor row exists but OutputSchemaId is null — the output schema from "
            + "src/tests/BaseApi.Tests/Schemas/tree.json has not been registered, so nothing "
            + "enforces shape, entry count or depth");
    }

    [Fact]
    public async Task AtTheDefaultDepthANestedZipStaysAFile()
    {
        RealStack.SkipUnlessEnabled();

        // The wired ArchiveExpander step omits maxDepth, so this is the default path: the outer zip
        // is expanded and the inner one is recorded as a file. It pins that splitting FileFetcher out
        // and adding nesting did not change what an existing workflow produces.
        var name = $"outer-{Guid.NewGuid():N}.zip";
        var path = SeedBytes(name, ZipOf(
            ("inner.zip", ZipOf(("a.csv", "id\n"u8.ToArray()))),
            ("b.csv", "id,name\n"u8.ToArray())));

        await ProduceAsync(path);

        var doc = Await(name, Window);
        Assert.True(doc.HasValue, $"no document naming {name} reached {OutTopic} within {Window.TotalMinutes:0} minutes");

        var root = doc!.Value;
        Assert.Equal(2, root.GetProperty("metadata").GetProperty("entryCount").GetInt32());

        var inner = root.GetProperty("content").EnumerateArray()
            .Single(e => e.GetProperty("metadata").GetProperty("name").GetString() == "inner.zip");

        // A base64 string, not an array. An archive that was not opened is a file.
        Assert.Equal(JsonValueKind.String, inner.GetProperty("content").ValueKind);
        Assert.Equal(0, inner.GetProperty("metadata").GetProperty("entryCount").GetInt32());
    }

    [Fact]
    public async Task ACorruptZipFailsAndLogsTheFileName()
    {
        RealStack.SkipUnlessEnabled();

        // The cross-check, in the cluster. Hermetically this already passes; what only the live run
        // can show is that ArchiveExpander's failure is diagnosable from ITS OWN log, given that it
        // has no path to name any more.
        //
        // RENAMED FROM ACorruptZipFailsWithThePathInTheLog. FileReader used to log the path here;
        // ArchiveExpander receives only an envelope from FileFetcher and has no FileInfo, no path,
        // and nothing in this assembly that could produce one — `extracting {fileName} failed: ...`
        // names the file, not a location on disk. The path-reaching-the-log-store guarantee this
        // test used to carry moved with the path: it now belongs to FileFetcher's own rejection
        // template, asserted in
        // <see cref="BaseApi.Tests.Live.FileFetcher.FileFetcherLiveTests.AFileWithTheWrongExtensionProducesNoDocument"/>.
        // This test still proves what only the cluster can show for THIS pod: that a failure reported
        // by the post handler is traceable to a file name, not a stack trace with nothing in it.
        var name = $"broken-{Guid.NewGuid():N}.zip";
        var path = SeedBytes(name, "this is not a zip"u8.ToArray());

        await ProduceAsync(path);

        Assert.Null(Await(name, Window));

        Assert.True(
            LogContains($"extracting {name} failed", Window),
            $"the step failed but no log line named {name} — a corrupt archive that fails through "
            + "the framework's general catch instead of ArchiveExtractionException logs a stack "
            + "trace with the file name nowhere, which is the seam failure this message exists to "
            + "close");
    }

    [Fact]
    public async Task ADocumentDeeperThanTheSchemaFailsAndLogsTheDepth()
    {
        RealStack.SkipUnlessEnabled();

        Assert.SkipWhen(DeepTopic.Length == 0,
            "set SKP_FILEREADER_DEEP_TOPIC to the input topic of a second workflow whose "
            + "ArchiveExpander step is wired {\"maxDepth\":2}; depth is a step payload, so this case "
            + "needs a workflow of its own");

        // THE DESTRUCTIVE FAILURE, and the only one whose diagnosis depends on a log line.
        //
        // maxDepth 2 against a baseline schema that admits depth 1: the document is built, then
        // rejected by the post handler, which reports Failed with EntryId Guid.Empty, acks, and
        // writes nothing to L2. The step's input was already reclaimed, so the branch is gone with
        // no key to recover it and no file identity in that failure.
        //
        // The disagreement is deliberate -- nothing syncs MaxDepth with the schema -- so this test
        // is not asserting a bug. It asserts that when an operator raises one without the other,
        // the evidence needed to work that out is actually present.
        var name = $"deep-{Guid.NewGuid():N}.zip";
        var path = SeedBytes(name, ZipOf(
            ("a.zip", ZipOf(("a.csv", "id\n"u8.ToArray())))));

        await ProduceToAsync(DeepTopic, path);

        Assert.Null(Await(name, Window));

        // Matches the current template: "expanded {FileName} of {SizeBytes} bytes into
        // {EntryCount} entries, reaching depth {DepthReached} of {MaxDepth}".
        Assert.True(
            LogContains("reaching depth 2 of 2", Window),
            "the document never reached the out topic and the depth line is missing too, so nothing "
            + "distinguishes a schema rejection from the file never having been fetched at all — "
            + "which is exactly the gap this line was added to close");
    }
}
