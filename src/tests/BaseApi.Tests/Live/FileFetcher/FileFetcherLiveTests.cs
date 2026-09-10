using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http;
using System.Reflection;
using System.Text.Json;
using Confluent.Kafka;
using Processor.FileFetcher;
using Xunit;

namespace BaseApi.Tests.Live.FileFetcher;

/// <summary>
/// The half of the FileFetcher → ArchiveExpander chain that only FileFetcher can answer: the
/// <c>hostPath</c> mount, seeding a file onto the kind node with <c>docker cp</c>, the manifest's
/// file-size ceiling, the extension whitelist, and the processor's own log line. Everything in the
/// hermetic FileFetcher suite runs against a temp file and an in-process processor, which is what
/// keeps that run cluster-free — but it also means the mount, the node-container detail underneath
/// it, and the wiring downstream of a rejection have no test above them. This file is that test.
/// <para>
/// Needs <c>SKP_REALSTACK=1</c>, <c>k8s/port-forward-realstack.ps1</c> and
/// <c>tools/kafka-dev-broker.ps1 -Up</c>. It seeds a file onto the kind node with <c>docker cp</c>,
/// so the node must be running.
/// </para>
/// </summary>
/// <remarks>
/// Shares the <c>kafka-broker</c> collection with <see cref="KafkaImporterLiveTests"/>,
/// <see cref="KafkaExporterLiveTests"/> and <see cref="ArchiveExpander.ArchiveExpanderLiveTests"/>,
/// which stop and start the shared dev Kafka container. Without the collection, xunit's default
/// parallelism (<c>maxParallelThreads: 6</c> in <c>xunit.runner.json</c>) could run this class while
/// the broker is down, producing a flaky failure that looks like a FileFetcher bug instead of the
/// borrowed-infrastructure race it is.
/// </remarks>
[Trait("Category", RealStack.Category)]
[Collection("kafka-broker")]
public sealed class FileFetcherLiveTests
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

    /// <summary>Copies plain bytes onto the node under the mounted directory.</summary>
    private static string SeedBytes(string name, byte[] bytes)
    {
        var local = Path.Combine(Path.GetTempPath(), name);
        File.WriteAllBytes(local, bytes);
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
    /// Produces with <c>ProduceAsync</c> and checks the delivery report, not <c>Produce</c> plus
    /// <c>Flush</c>: flush only proves the local queue drained, which stays silent whether the
    /// broker accepted the record or rejected it. A silent send here would let
    /// <see cref="AFileWithTheWrongExtensionProducesNoDocument"/>'s absence mean "nothing ran
    /// because the send never landed" as easily as "the whitelist correctly rejected the file" —
    /// the two outcomes that test exists to tell apart.
    /// </summary>
    private static async Task ProduceAsync(string path)
    {
        using var producer = new ProducerBuilder<Null, string>(
            new ProducerConfig { BootstrapServers = RealStack.KafkaBrokers }).Build();

        var result = await producer.ProduceAsync(RealStack.KafkaTopic, new Message<Null, string>
        {
            // providerName rides along exactly as the org's records carry it, and the reader must
            // ignore it.
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
            GroupId = $"live-filefetcher-{Guid.NewGuid():N}",
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

    /// <summary>The deployment whose logs carry this processor's own messages.</summary>
    private static string Deployment => RealStack.Get("SKP_FILEFETCHER_DEPLOYMENT", "processor-filefetcher");

    private static string Namespace => RealStack.Get("SKP_NAMESPACE", "skp");

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
    /// "nothing arrived" indistinguishable from "nothing arrived yet", which is a false pass. The
    /// invariant used to be asserted in a comment; here it is structural.
    /// </para>
    /// <para>
    /// <b>Five minutes, raised from two on 2026-09-10, because two was not enough.</b> The suite
    /// runs its live tests concurrently (xunit <c>maxParallelThreads: 6</c>) and every one of them
    /// produces to the same topic; the importer drains a batch per cron tick and each processor
    /// takes one dispatch at a time, so the work serialises and whichever file is last in the batch
    /// waits behind all the others. Two tests failed on that alone — their log lines were present
    /// and correct, timestamped after the assertion had given up. This is a bound on the WHOLE
    /// pipeline under concurrent load, not on any single step.
    /// </para>
    /// <para>
    /// It costs wall-clock on the negative tests, which burn the full window by construction. That
    /// is the price of the guarantee above; shortening it back buys minutes and loses the meaning
    /// of every <c>Assert.Null</c> in this file.
    /// </para>
    /// </summary>
    private static readonly TimeSpan Window = TimeSpan.FromMinutes(5);

    /// <summary>
    /// Polls the log until it contains <paramref name="needle"/>, or the deadline passes.
    /// <para>
    /// Polled rather than read once: the document reaching Kafka (or failing to) and the line
    /// reaching the log store are not ordered, so a single read straight after the assertion on the
    /// topic is a race that fails intermittently and looks like a missing log line.
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
    /// This build's source hash, read from the assembly rather than pasted in.
    /// <para>
    /// <c>SourceHash.targets</c> emits it as an <c>AssemblyMetadata</c> attribute, and it changes on
    /// every source edit — a literal here would be stale by the next commit and would fail as a
    /// missing processor row, which reads like a deployment fault rather than a stale constant.
    /// </para>
    /// </summary>
    private static string SourceHash
        => typeof(FetchedFile).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .Single(a => a.Key == "SourceHash").Value!;

    [Fact]
    public async Task ASeededFileBecomesAnEnvelope()
    {
        RealStack.SkipUnlessEnabled();

        // THE MOUNT, END TO END: a file placed on the node with `docker cp`, named by an absolute
        // path in the importer's record, becomes bytes FileFetcher can open. Nothing hermetic can
        // reach this — the in-process hermetic suite never touches a real filesystem mount, let
        // alone one that lives on a container Windows cannot see directly.
        //
        // The assertion is the processor's OWN log line, not a document on some downstream topic:
        // ArchiveExpander turning this envelope into a document is a SEPARATE claim, covered in
        // ArchiveExpanderLiveTests. This test asks only what FileFetcher itself can answer — did the
        // mount, the seed and the whitelist let the fetch succeed.
        var name = $"orders-{Guid.NewGuid():N}.zip";
        var path = SeedZip(name, ("a.csv", "id\n"), ("b.csv", "id,name\n"));

        await ProduceAsync(path);

        Assert.True(
            LogContains($"fetched {name} (.zip)", Window),
            $"no 'fetched {name} (.zip)' line reached the FileFetcher log within {Window.TotalMinutes:0} minutes — "
            + "the mount, the seed, or the whitelist did not let the fetch through");
    }

    [Fact]
    public async Task AFileWithTheWrongExtensionProducesNoDocument()
    {
        RealStack.SkipUnlessEnabled();

        // The step is wired AllowedExtensions [".zip"]. A .txt fails FileFetcher's dry guard before
        // any byte is read, the step reports Failed, and neither ArchiveExpander nor the exporter —
        // both wired PreviousCompleted, not Always — ever runs. The absence IS the assertion: an
        // Always-wired downstream would publish here, which is the bug that wiring caused before,
        // now spanning two edges instead of one (FileFetcher → ArchiveExpander, then
        // ArchiveExpander → KafkaExporter).
        var name = $"orders-{Guid.NewGuid():N}.txt";
        var local = Path.Combine(Path.GetTempPath(), name);
        File.WriteAllText(local, "not a zip");
        Run("docker", $"cp \"{local}\" {Node}:{NodeDir}/{name}");
        var path = $"{NodeDir}/{name}";

        await ProduceAsync(path);

        // The SAME Window the positive tests use, and that is the whole point: a shorter wait here
        // would only prove the pipeline hadn't produced a document YET, not that it never would,
        // and the two outcomes look identical from outside. See Window for why it is one field.
        Assert.Null(Await(name, Window));

        // THE MOVED ASSERTION. The old FileReader-era failure line named a path; so does this one —
        // `file {path} rejected: ...` is unchanged from FileReader, and it is now the ONLY failure
        // template in either pod that still carries a full path (ArchiveExpander's own failure names
        // a file, not a path — it has no path to name). A file that fails the whitelist is where the
        // path-reaching-the-log-store guarantee actually lives now.
        Assert.True(
            LogContains($"file {path} rejected: extension '.txt' is not in the allowed list",
                Window),
            $"the step failed but no log line named {path} — the path-reaching-the-log-store "
            + "guarantee this assertion exists to pin");
    }

    /// <summary>
    /// THE GAP CLOSED. <c>k8s/README.md</c> used to note there was no live assertion naming
    /// FileFetcher's own processor row — only ArchiveExpander's <c>TheOutputSchemaRowIsRegistered</c>
    /// existed, because the two processors still lived in one file exercising the whole chain. Now
    /// that FileFetcher has a file of its own, it gets the same proof ArchiveExpander already had:
    /// that its own output schema (<c>file-envelope</c>) is actually registered, not merely present
    /// as a file under <c>src/Processor.FileFetcher/schema/</c>.
    /// </summary>
    [Fact]
    public async Task TheOutputSchemaRowIsRegistered()
    {
        RealStack.SkipUnlessEnabled();

        // With OutputSchemaId null, TryValidate returns true without decoding a byte: the schema
        // enforces nothing, and a document arriving downstream is not evidence the schema was
        // applied — it is evidence a document was produced, which is a different claim. See
        // ArchiveExpanderLiveTests.TheOutputSchemaRowIsRegistered for the downstream half of the
        // same guarantee.
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
            + "src/Processor.FileFetcher/schema/output.json has not been registered, so nothing "
            + "enforces the envelope's shape on the way out of this pod");
    }
}
