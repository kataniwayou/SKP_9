using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http;
using System.Reflection;
using System.Text.Json;
using Confluent.Kafka;
using Processor.FileReader;
using Xunit;

namespace BaseApi.Tests.Live.FileReader;

/// <summary>
/// The whole chain, against the real cluster: a path on the node becomes a document on the
/// exporter's topic. Everything in the hermetic FileReader suite runs against temp files and an
/// in-process processor, which is what keeps that run cluster-free — but it also means the mount,
/// the manifest's ceiling, the workflow wiring and the two entry conditions have no test above them.
/// This file is that test.
/// <para>
/// Needs <c>SKP_REALSTACK=1</c>, <c>k8s/port-forward-realstack.ps1</c> and
/// <c>tools/kafka-dev-broker.ps1 -Up</c>. It seeds a file onto the kind node with <c>docker cp</c>,
/// so the node must be running.
/// </para>
/// </summary>
/// <remarks>
/// Shares the <c>kafka-broker</c> collection with <see cref="KafkaImporterLiveTests"/> and
/// <see cref="KafkaExporterLiveTests"/>, which stop and start the shared dev Kafka container.
/// Without the collection, xunit's default parallelism (<c>maxParallelThreads: 6</c> in
/// <c>xunit.runner.json</c>) could run this class while the broker is down, producing a flaky
/// failure that looks like a FileReader bug instead of the borrowed-infrastructure race it is.
/// </remarks>
[Trait("Category", RealStack.Category)]
[Collection("kafka-broker")]
public sealed class FileReaderLiveTests
{
    private const string NodeDir = "/mnt/skp-files/in";
    private static string Node => RealStack.Get("SKP_KIND_NODE", "desktop-control-plane");
    private static string OutTopic => RealStack.Get("SKP_KAFKA_OUT_TOPIC", "skp-documents");

    /// <summary>Builds a zip locally and copies it onto the node the pod mounts.</summary>
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
    /// broker accepted the record or rejected it. A silent send here would let
    /// <see cref="AFileWithTheWrongExtensionProducesNoDocument"/>'s absence mean "nothing ran
    /// because the send never landed" as easily as "the extension guard correctly failed the
    /// step" — the two outcomes that test exists to tell apart.
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
            GroupId = $"live-filereader-{Guid.NewGuid():N}",
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

        var name = $"orders-{Guid.NewGuid():N}.zip";
        var path = SeedZip(name, ("a.csv", "id\n"), ("b.csv", "id,name\n"));

        await ProduceAsync(path);

        var doc = Await(name, TimeSpan.FromMinutes(2));
        Assert.True(doc.HasValue, $"no document naming {name} reached {OutTopic} within two minutes");

        var root = doc!.Value;
        Assert.Equal(JsonValueKind.Array, root.GetProperty("content").ValueKind);
        Assert.Equal(2, root.GetProperty("metadata").GetProperty("entryCount").GetInt32());
        Assert.Equal(2, root.GetProperty("content").GetArrayLength());

        // The one field the reader is required to drop.
        Assert.DoesNotContain("acme", root.GetRawText(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task AFileWithTheWrongExtensionProducesNoDocument()
    {
        RealStack.SkipUnlessEnabled();

        // The step is wired ExpectedExtension ".zip". A .txt fails the dry guard, the step reports
        // Failed, and the exporter — wired PreviousCompleted, not Always — never runs. The absence
        // IS the assertion: an Always-wired exporter would publish here, which is the bug that
        // wiring caused before.
        var name = $"orders-{Guid.NewGuid():N}.txt";
        var local = Path.Combine(Path.GetTempPath(), name);
        File.WriteAllText(local, "not a zip");
        Run("docker", $"cp \"{local}\" {Node}:{NodeDir}/{name}");

        await ProduceAsync($"{NodeDir}/{name}");

        // Same two-minute window as the positive test, on purpose: a shorter wait here would only
        // prove the pipeline hadn't produced a document YET, not that it never would, and the two
        // outcomes look identical from outside. Now the absence at two minutes means what the
        // positive test's presence at two minutes means -- the pipeline had the same chance to act
        // and didn't.
        Assert.Null(Await(name, TimeSpan.FromMinutes(2)));
    }

    // ---------------------------------------------------------------------------------------
    // Nested expansion, live. The hermetic suite proves the depth logic against an in-process
    // processor; what it cannot reach is the registered output schema, which exists only as a
    // database row in the cluster. Every assertion below is about something that row decides.
    // ---------------------------------------------------------------------------------------

    /// <summary>The deployment whose logs carry the processor's own messages.</summary>
    private static string Deployment => RealStack.Get("SKP_FILEREADER_DEPLOYMENT", "processor-filereader");

    private static string Namespace => RealStack.Get("SKP_NAMESPACE", "skp");

    /// <summary>
    /// The topic feeding a SECOND workflow whose FileReader step is wired <c>maxDepth: 2</c>.
    /// <para>
    /// <b>It is a separate workflow because depth is a step payload, not a message field.</b> One
    /// wired workflow has one payload, so a test cannot ask for a different depth by producing a
    /// different record — the depth is decided by the row an operator wrote. Unset by default, and
    /// the test that needs it skips with instructions rather than failing.
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

    [Fact]
    public async Task TheOutputSchemaRowIsRegistered()
    {
        RealStack.SkipUnlessEnabled();

        // THE TEST THAT MAKES THE OTHERS MEAN ANYTHING. With OutputSchemaId null, TryValidate
        // returns true without decoding a byte: the schema enforces nothing, and every other live
        // assertion here passes vacuously. A document arriving on the out topic is NOT evidence the
        // schema was applied — it is evidence a document was produced, which is a different claim.
        //
        // This is also the second of the three deploy steps, so a failure here names the step that
        // was skipped rather than surfacing later as an unexplained absence of enforcement.
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
            + "src/Processor.FileReader/schema/output.json has not been registered, so nothing "
            + "enforces shape, entry count or depth");
    }

    [Fact]
    public async Task AtTheDefaultDepthANestedZipStaysAFile()
    {
        RealStack.SkipUnlessEnabled();

        // The wired step omits maxDepth, so this is the default path: the outer zip is expanded and
        // the inner one is recorded as a file. It pins that adding nesting did not change what an
        // existing workflow produces.
        var name = $"outer-{Guid.NewGuid():N}.zip";
        var path = SeedBytes(name, ZipOf(
            ("inner.zip", ZipOf(("a.csv", "id\n"u8.ToArray()))),
            ("b.csv", "id,name\n"u8.ToArray())));

        await ProduceAsync(path);

        var doc = Await(name, TimeSpan.FromMinutes(2));
        Assert.True(doc.HasValue, $"no document naming {name} reached {OutTopic} within two minutes");

        var root = doc!.Value;
        Assert.Equal(2, root.GetProperty("metadata").GetProperty("entryCount").GetInt32());

        var inner = root.GetProperty("content").EnumerateArray()
            .Single(e => e.GetProperty("metadata").GetProperty("name").GetString() == "inner.zip");

        // A base64 string, not an array. An archive that was not opened is a file.
        Assert.Equal(JsonValueKind.String, inner.GetProperty("content").ValueKind);
        Assert.Equal(0, inner.GetProperty("metadata").GetProperty("entryCount").GetInt32());
    }

    [Fact]
    public async Task ACorruptZipFailsWithThePathInTheLog()
    {
        RealStack.SkipUnlessEnabled();

        // The cross-check, in the cluster. Hermetically this already passes; what only the live run
        // can show is that the PATH reaches the log store — which is the entire reason these checks
        // live in ProcessAsync rather than in the schema. A failure reported by the post handler
        // carries EntryId Guid.Empty and no path at all.
        var name = $"broken-{Guid.NewGuid():N}.zip";
        var path = SeedBytes(name, "this is not a zip"u8.ToArray());

        await ProduceAsync(path);

        Assert.Null(Await(name, TimeSpan.FromMinutes(2)));

        Assert.True(
            LogContains($"extracting {path} failed", TimeSpan.FromMinutes(1)),
            $"the step failed but no log line named {path} — a corrupt archive that fails through "
            + "the framework's general catch instead of ArchiveExtractionException logs a stack "
            + "trace with the path nowhere, which is the seam failure this message exists to close");
    }

    [Fact]
    public async Task ADocumentDeeperThanTheSchemaFailsAndLogsTheDepth()
    {
        RealStack.SkipUnlessEnabled();

        Assert.SkipWhen(DeepTopic.Length == 0,
            "set SKP_FILEREADER_DEEP_TOPIC to the input topic of a second workflow whose FileReader "
            + "step is wired {\"expectedExtension\":\".zip\",...,\"maxDepth\":2}; depth is a step "
            + "payload, so this case needs a workflow of its own");

        // THE DESTRUCTIVE FAILURE, and the only one whose diagnosis depends on a log line.
        //
        // maxDepth 2 against a baseline schema that admits depth 1: the document is built, then
        // rejected by the post handler, which reports Failed with EntryId Guid.Empty, acks, and
        // writes nothing to L2. The step's input was already reclaimed, so the branch is gone with
        // no key to recover it and no file path in that log.
        //
        // The disagreement is deliberate -- nothing syncs MaxDepth with the schema -- so this test
        // is not asserting a bug. It asserts that when an operator raises one without the other,
        // the evidence needed to work that out is actually present.
        var name = $"deep-{Guid.NewGuid():N}.zip";
        var path = SeedBytes(name, ZipOf(
            ("a.zip", ZipOf(("a.csv", "id\n"u8.ToArray())))));

        await ProduceToAsync(DeepTopic, path);

        Assert.Null(Await(name, TimeSpan.FromMinutes(2)));

        Assert.True(
            LogContains("expanded to depth 2 of 2", TimeSpan.FromMinutes(1)),
            "the document never reached the out topic and the depth line is missing too, so nothing "
            + "distinguishes a schema rejection from the file never having been read at all — which "
            + "is exactly the gap this line was added to close");
    }
}
