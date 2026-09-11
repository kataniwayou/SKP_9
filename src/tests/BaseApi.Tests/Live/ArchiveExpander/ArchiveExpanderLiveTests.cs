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

    /// <summary>
    /// Where FilePersister writes, and the only place a test can see what the chain produced.
    /// <para>
    /// The out topic carries a path, not content — so an assertion about BYTES has to follow that
    /// path back to the node. A different directory from <see cref="NodeDir"/> on purpose: writing
    /// back into the input folder would make the comparison meaningless.
    /// </para>
    /// </summary>
    private const string OutDir = "/mnt/skp-files/out";
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
    /// The bytes FilePersister wrote, copied off the node.
    /// <para>
    /// <c>docker cp</c> rather than <c>docker exec cat</c>: <see cref="Run"/> deliberately does not
    /// redirect stdout — see its comment for why a pipe nobody drains is a deadlock — and these are
    /// archive bytes, which do not survive a text pipe anyway.
    /// </para>
    /// </summary>
    private static byte[] ReadBack(string name)
    {
        var local = Path.Combine(Path.GetTempPath(), $"out-{name}");
        Run("docker", $"cp {Node}:{OutDir}/{name} \"{local}\"");
        return File.ReadAllBytes(local);
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
            // filePath ALONE. This carried providerName = "acme-feed" until 2026-09-11, on the
            // grounds that the org's records carry it and the reader must ignore it -- true of
            // FileLocator, which binds case-insensitively and drops unknowns, and false of the
            // registered schema. file-locator declares additionalProperties: false, so a second key
            // never reaches the reader: KafkaImporter's OWN output validation refuses the record and
            // the lineage ends at the first hop, with every test here timing out on a chain that
            // never ran. Observed as
            //   warn ProcessedDataHandler: output failed its schema -- reported failed: /providerName:
            //
            // The guarantee the old field tested has not been lost, it moved and got stronger: an
            // unexpected key used to be dropped downstream, and is now refused at the edge.
            Value = JsonSerializer.Serialize(new { filePath = path }),
        });

        Assert.True(result.Status == PersistenceStatus.Persisted,
            $"produce to {RealStack.KafkaTopic} did not persist: status was {result.Status}");
    }

    /// <summary>
    /// The path the file was written to, off the first locator on the out topic naming it --
    /// or null on timeout. See the matcher below for why this is a path and not a document.
    /// </summary>
    private static string? Await(string name, TimeSpan timeout)
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

            // THE TERMINAL SHAPE, WHICH IS A LOCATOR AND NOT A DOCUMENT. This matched
            // metadata.name until 2026-09-11 -- an ArchiveExpander document -- and had not been
            // able to match anything since the chain stopped ending at the expander. The out topic
            // carried envelopes once ArchiveCollapser was appended (2026-09-10) and carries
            // {"filePath"} locators now that FilePersister precedes the exporter. A sink is the only
            // way onto a topic, its single inputSchemaId is file-locator, and SourceHash is unique
            // per processor row -- so no workflow can ever put a mid-chain shape on a topic, and
            // this is the only shape a test can wait for.
            if (root.TryGetProperty("filePath", out var filePath)
                && filePath.GetString() is { Length: > 0 } written
                && Path.GetFileName(written) == name)
            {
                return written;
            }
        }

        return null;
    }

    [Fact]
    public async Task AZipOnTheNodeTraversesTheChainAndIsWrittenBack()
    {
        RealStack.SkipUnlessEnabled();

        // THE WHOLE CHAIN: a zip seeded onto the node reaches FileFetcher through the mount, becomes
        // an envelope, is expanded to a document, collapsed back to an envelope, written to the out
        // folder by FilePersister, and its path published by the exporter. This is what proves the
        // mount, every pod's manifest, and every edge between them are wired together — no hermetic
        // suite can, because each one replaces its own processor's neighbours with an in-process call.
        //
        // RENAMED FROM AZipOnTheNodeBecomesADocumentOnTheOutTopic, and the rename is the honest part:
        // this asserts SIX HOPS, not one. It waited for a document and inspected its entryCount and
        // its content array, which was a claim about ArchiveExpander alone while the expander was the
        // last step. It has not been since 2026-09-10. A document never reaches a topic now and
        // cannot: a sink is the only way onto one, its single inputSchemaId is file-locator, and
        // SourceHash is unique per processor row -- so there is no second exporter identity to give
        // a different input schema to, and no workflow can end anywhere but here.
        //
        // WHAT THAT COSTS, SAID PLAINLY: a failure in the collapser or the persister now surfaces as
        // an ArchiveExpander failure. When this goes red, read the correlation-id trace before
        // reading the test name -- the orchestrator's hand-off lines bracket every step, so the hop
        // that actually broke is visible there and is not visible here.
        var name = $"orders-{Guid.NewGuid():N}.zip";
        var path = SeedZip(name, ("a.csv", "id\n"), ("b.csv", "id,name\n"));

        await ProduceAsync(path);

        var written = Await(name, Window);
        Assert.False(string.IsNullOrEmpty(written),
            $"no locator naming {name} reached {OutTopic} within {Window.TotalMinutes:0} minutes");

        // The path is minted by FilePersister from its configured folder and the envelope's file
        // name -- not folder + name + extension, which would read orders-....zip.zip.
        Assert.Equal($"{OutDir}/{name}", written);

        // The ENTRIES, one layer down, because the topic no longer carries them. Deliberately not a
        // byte comparison against the seeded file: the chain rebuilds the archive rather than copying
        // it, so a first pass over an archive this system did not write differs in its container
        // framing -- platform stamp, compression level -- while every entry's content is identical.
        // The entries are the claim that survives both.
        using var archive = new ZipArchive(new MemoryStream(ReadBack(name)), ZipArchiveMode.Read);

        Assert.Equal(["a.csv", "b.csv"], archive.Entries.Select(e => e.Name).Order().ToArray());
        Assert.Equal("id,name\n", new StreamReader(
            archive.Entries.Single(e => e.Name == "b.csv").Open()).ReadToEnd());

        // NO providerName ASSERTION. It used to read Assert.DoesNotContain("acme", ...) against the
        // document, proving the reader dropped a field the producer sent. The producer cannot send
        // one any more -- file-locator's additionalProperties: false makes the importer refuse the
        // whole record -- so the assertion would be vacuous. What replaced it is not a test here but
        // the schema row itself, one hop earlier and binding on every producer rather than this one.
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

    [Fact]
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

    // REMOVED 2026-09-11: AtTheDefaultDepthANestedZipStaysAFile.
    //
    // It seeded outer.zip containing inner.zip, waited for the document, and asserted inner.zip
    // arrived as a base64 STRING with entryCount 0 -- an archive the depth limit did not open is a
    // file. Two independent reasons it cannot be ported:
    //
    // Its subject exists only in the intermediate document. By the time anything reaches a topic
    // ArchiveCollapser has rebuilt the archive, and a rebuilt outer.zip containing inner.zip is
    // identical whether the inner one was left closed or expanded and repacked. There is nothing
    // left at the terminal to distinguish the two.
    //
    // And its premise was already false. It says "the wired ArchiveExpander step omits maxDepth, so
    // this is the default path". That step is wired {"maxDepth": 4}. It has been asserting the
    // default against a step that is not at the default.
    //
    // ArchiveExpanderDepthTests covers the depth rule hermetically, against an in-process processor
    // where the document is still in hand -- which is the only place this claim can be made.

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

    // REMOVED 2026-09-11: ADocumentDeeperThanTheSchemaFailsAndLogsTheDepth.
    //
    // It asserted that a depth-2 document is REJECTED by the post handler against a registered
    // schema admitting depth 1, and that the expander's "reaching depth {DepthReached} of
    // {MaxDepth}" line is the only place the depth survives to diagnose that rejection. Its premise
    // was that MaxDepth and the output schema each state a depth and nothing keeps them in sync.
    //
    // archive-document v3.0.0 removed the schema's half of that. It is one self-referencing node
    // admitting any depth, so no document is "deeper than the schema" and the rejection this test
    // waited for cannot happen -- Assert.Null(Await(...)) would now fail on a document that arrived
    // exactly as it should. See src/tests/BaseApi.Tests/Schemas/README.md for why the ladder went.
    //
    // Not replaced, deliberately: both remaining bounds are covered hermetically.
    // ArchiveExpanderDepthTests.ADepthOutsideTheSupportedRangeIsARejectedPayload covers a MaxDepth
    // above MaxSupportedDepth, diagnosed before a file is opened, and
    // ArchiveBuilderTests.ADocumentDeeperThanMaxSupportedDepthFails covers a document from
    // elsewhere that is too deep to pack. Neither needs a second workflow or a live cluster --
    // which is why this one was skipped by default and went stale unnoticed.
    //
    // Two members went with it and are not coming back: DeepTopic (SKP_FILEREADER_DEEP_TOPIC, the
    // second workflow's in-topic) and ProduceToAsync(topic, path), which existed to address it.
    // SKP_FILEREADER_DEEP_TOPIC is still documented in k8s/README.md and now reads nowhere.
}
