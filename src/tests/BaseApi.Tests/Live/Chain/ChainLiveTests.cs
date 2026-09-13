using System.Diagnostics;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using Confluent.Kafka;
using Xunit;

namespace BaseApi.Tests.Live.Chain;

/// <summary>
/// THE WHOLE CHAIN, END TO END: a bundle seeded onto the node reaches FileFetcher through the mount,
/// becomes an envelope, is expanded to a document, NORMALIZED by SKNormalizer, collapsed back to an
/// envelope, written to the out folder by FilePersister, and its path published by the exporter.
/// Seven hops. This is what proves the mount, every pod's manifest, and every edge between them are
/// wired together — no hermetic suite can, because each one replaces its own processor's neighbours
/// with an in-process call.
/// <para>
/// <b>MOVED OUT OF <c>ArchiveExpanderLiveTests</c> ON 2026-09-13, because it never belonged there.</b>
/// It asserted seven hops from a file named after one processor, so a refusal anywhere in the chain
/// was reported as an ArchiveExpander failure. That is not hypothetical: on 2026-09-12 SKNormalizer
/// refused the seeded archive and the suite reported
/// <c>ArchiveExpanderLiveTests.AZipOnTheNodeTraversesTheChainAndIsWrittenBack</c> failing after five
/// minutes — naming the wrong processor, and giving the reason nowhere. The old file's own comment
/// predicted it: "a failure in the collapser or the persister now surfaces as an ArchiveExpander
/// failure."
/// </para>
/// <para>
/// <b>THE INPUT IS AN ACME BUNDLE, AND IT HAS TO BE.</b> The chain carries an SKNormalizer step wired
/// <c>{"handler":"Acme"}</c>, and <c>AcmeHandler</c> groups an archive's root entries by BASENAME and
/// requires each group to be exactly one <c>.wav</c> and one <c>.json</c>. The predecessor of this
/// test seeded <c>a.csv</c> + <c>b.csv</c>, which become two single-node items, and the first one is
/// refused: <c>item 'a': an Acme item needs exactly one .wav and one .json, and this one holds 0 and
/// 0</c>. The refusal was CORRECT — that archive is not an Acme bundle — so the fixture is what
/// changed, not the chain.
/// </para>
/// <para>
/// <b>AND THE ROUND TRIP IS NO LONGER AN IDENTITY.</b> The predecessor asserted the output archive
/// still held the entries it seeded. With a normalizer in the chain it never can: the handler
/// replaces the JSON sidecar with rendered XML and transcodes the audio, so <c>track01.wav</c> +
/// <c>track01.json</c> in becomes <c>track01.mp3</c> + <c>track01.xml</c> out. Asserting preservation
/// would be asserting the normalizer does nothing. What is asserted below is the TRANSFORMATION.
/// </para>
/// </summary>
/// <remarks>
/// Shares the <c>kafka-broker</c> collection with the other live classes that stop and start the
/// shared dev Kafka container. Without it, xunit's default parallelism could run this class while
/// the broker is down, producing a flaky failure that looks like a chain fault rather than the
/// borrowed-infrastructure race it is.
/// <para>
/// <c>Run</c> and <c>Capture</c> are duplicated from the sibling live classes rather than shared.
/// That is the convention here — ArchiveCollapser, ArchiveExpander and FileFetcher each carry their
/// own — and following it keeps this file self-contained; factoring all four at once is a separate
/// change.
/// </para>
/// </remarks>
[Trait("Category", RealStack.Category)]
[Collection("kafka-broker")]
public sealed class ChainLiveTests
{
    private const string NodeDir = "/mnt/skp-files/in";

    /// <summary>The CSV line ending the negative fixture writes.</summary>
    private const string NL = "\n";
    private const string OutDir = "/mnt/skp-files/out";

    private static string Node => RealStack.Get("SKP_KIND_NODE", "desktop-control-plane");
    private static string Namespace => RealStack.Get("SKP_NAMESPACE", "skp");
    private static string OutTopic => RealStack.Get("SKP_KAFKA_OUT_TOPIC", "skp-documents");

    /// <summary>
    /// Five minutes, matching the window the live classes share. The live tests run concurrently and
    /// all produce to the same topic; the importer drains a batch per cron tick and each processor
    /// takes one dispatch at a time, so the work serialises and the last file in a batch waits behind
    /// every other. This bounds the WHOLE pipeline under concurrent load, not one step.
    /// </summary>
    private static readonly TimeSpan Window = TimeSpan.FromMinutes(5);

    /// <summary>How often the wait below stops to ask whether a step has already refused the file.</summary>
    private static readonly TimeSpan FailureCheck = TimeSpan.FromSeconds(15);

    /// <summary>
    /// Every pod the chain runs through, as ONE label selector so the failure check costs one
    /// <c>kubectl</c> invocation rather than seven. <c>--max-log-requests</c> has to be raised past
    /// its default of 5: the chain is seven deployments and two of them run more than one replica.
    /// </summary>
    private const string ChainSelector =
        "app in (processor-kafkaimporter,processor-filefetcher,processor-archiveexpander,"
        + "processor-sknormalizer,processor-archivecollapser,processor-filepersister,"
        + "processor-kafkaexporter)";

    [Fact]
    public async Task AnAcmeBundleTraversesTheChainAndIsWrittenBack()
    {
        RealStack.SkipUnlessEnabled();

        var name = $"acme-{Guid.NewGuid():N}.zip";
        var path = SeedBundle(name);

        await ProduceAsync(path);

        var outcome = AwaitOutcome(name, Window);

        Assert.Null(outcome.Refusal);
        var written = outcome.Locator;

        // The path is minted by FilePersister from its configured folder and the envelope's file
        // name -- not folder + name + extension, which would read acme-....zip.zip.
        Assert.Equal($"{OutDir}/{name}", written);

        using var archive = new ZipArchive(new MemoryStream(ReadBack(name)), ZipArchiveMode.Read);

        // NOT the entries that went in. The sidecar became XML and the audio was re-encoded; an
        // archive still holding track01.json would mean the normalizer ran and emitted its input.
        Assert.Equal(["track01.mp3", "track01.xml"], archive.Entries.Select(e => e.Name).Order().ToArray());

        // THE BYTES WERE REALLY REPLACED, not just renamed. ffmpeg writes an ID3 header; the seeded
        // wav begins "RIFF". An entry named .mp3 carrying the source wav is the exact lie
        // AcmeHandler.LayoutFor exists to prevent, and it is invisible to an entry-name assertion.
        var audio = new byte[3];
        using (var stream = archive.Entries.Single(e => e.Name == "track01.mp3").Open())
        {
            Assert.Equal(3, stream.ReadAtLeast(audio, 3, throwOnEndOfStream: false));
        }

        Assert.Equal("ID3", Encoding.ASCII.GetString(audio));

        var xml = new StreamReader(archive.Entries.Single(e => e.Name == "track01.xml").Open()).ReadToEnd();

        Assert.Contains("<provider>Acme</provider>", xml, StringComparison.Ordinal);
        Assert.Contains("<originalName>track01.json</originalName>", xml, StringComparison.Ordinal);

        // MEASURED FROM THE CONVERSION, not copied from the sidecar. These two are what
        // AcmeHandler.Reconcile overwrites, and they were WRONG in the cluster until 2026-09-12:
        // the transcoder probed ffmpeg's stderr unscoped and reported the INPUT's pcm_s16le at
        // 1411 kb/s about a file that is now mp3. Pinned deliberately -- the Acme profile is a
        // published contract, so changing it should require changing a test that says so.
        Assert.Contains("<fileName>track01.mp3</fileName>", xml, StringComparison.Ordinal);
        Assert.Contains("<codec>mp3</codec>", xml, StringComparison.Ordinal);
        Assert.Contains("<bitrateKbps>192</bitrateKbps>", xml, StringComparison.Ordinal);

        // The sidecar's own claim, untouched, because the profile names no -ar and no -ac. If a
        // future profile resamples, this is the element that silently starts lying.
        Assert.Contains("<sampleRateHz>44100</sampleRateHz>", xml, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ANonAcmeArchiveIsRefusedByTheNormalizerAndTheRunEndsThere()
    {
        RealStack.SkipUnlessEnabled();

        // THE TEST THAT MAKES THE FAIL-FAST ABOVE MEAN ANYTHING. Without it, AwaitOutcome's refusal
        // branch is error-handling that has never run, and the first time it matters is the first
        // time it is needed -- which is the worst moment to discover a typo in a log-matching string.
        //
        // It is also the live half of a claim the hermetic suite makes on its own: an archive that is
        // not an Acme bundle is refused, BY THE NORMALIZER, and the chain stops rather than writing a
        // partial result. This is the exact archive shape that was seeded here until 2026-09-13 --
        // two CSVs, two basenames, two single-node items -- kept as a fixture now that it is
        // understood as a negative case rather than the happy path.
        var name = $"notacme-{Guid.NewGuid():N}.zip";
        var path = SeedArchive(name, ("a.csv", "id" + NL), ("b.csv", "id,name" + NL));

        await ProduceAsync(path);

        var outcome = AwaitOutcome(name, Window);

        Assert.NotNull(outcome.Refusal);

        // The component AND the rule, because "something refused it" is not a diagnosis. The pod
        // prefix is what names the component; kubectl writes it because RefusalNaming asks for it.
        Assert.Contains("processor-sknormalizer", outcome.Refusal, StringComparison.Ordinal);
        Assert.Contains(
            "an Acme item needs exactly one .wav and one .json", outcome.Refusal, StringComparison.Ordinal);

        // Nothing was written. A refusal that still leaves a file in the out folder would mean a
        // later step ran on data its predecessor rejected.
        Assert.Empty(outcome.Locator);
        Assert.False(WrittenToOutFolder(name),
            $"{name} was refused by the chain but something still wrote it to {OutDir}");
    }

    /// <summary>
    /// The path the file was written to, off the first locator on the out topic naming it.
    /// <para>
    /// <b>IT ALSO WATCHES FOR A REFUSAL, and that is the point of this method.</b> Waiting only for
    /// success means every chain failure costs the full five minutes and reports "nothing arrived" —
    /// which names neither the step that refused nor the reason, both of which are sitting in a pod
    /// log the whole time. That is exactly how a correct SKNormalizer rejection was reported as an
    /// ArchiveExpander timeout on 2026-09-12. A refusal now fails the test in seconds, quoting the
    /// line.
    /// </para>
    /// <para>
    /// <b>It matches by FILE NAME, which bounds what it can catch.</b> The processors' own business
    /// failures name the file in their message ("normalizing {name} failed: …", "extracting {name}
    /// failed: …"), so those are caught. A SCHEMA rejection is not: since 2026-09-13 it names the
    /// schema it validated against, but it still carries no FILE NAME and no execution id in its
    /// text, so it cannot be attributed to this test's file and falls through to the window. See
    /// <c>docs/testing/schema-compatibility-live/LOGGING-GAPS.md</c> — G1 and G2 are closed; what
    /// would let this check cover schema refusals is a lineage key in the message itself.
    /// </para>
    /// </summary>
    private static ChainOutcome AwaitOutcome(string name, TimeSpan timeout)
    {
        using var consumer = new ConsumerBuilder<Ignore, string>(new ConsumerConfig
        {
            BootstrapServers = RealStack.KafkaBrokers,
            GroupId = $"live-chain-{Guid.NewGuid():N}",
            AutoOffsetReset = AutoOffsetReset.Earliest,
        }).Build();

        consumer.Subscribe(OutTopic);

        var deadline = DateTime.UtcNow + timeout;
        var nextCheck = DateTime.UtcNow + FailureCheck;

        while (DateTime.UtcNow < deadline)
        {
            var result = consumer.Consume(TimeSpan.FromSeconds(5));

            if (result?.Message?.Value is { Length: > 0 } value)
            {
                var root = JsonDocument.Parse(value).RootElement;

                // The terminal shape is a LOCATOR, not a document. A sink is the only way onto a
                // topic and its single inputSchemaId is file-locator, so no workflow can put a
                // mid-chain shape on a topic and this is the only shape a test can wait for.
                if (root.TryGetProperty("filePath", out var filePath)
                    && filePath.GetString() is { Length: > 0 } written
                    && Path.GetFileName(written) == name)
                {
                    return new ChainOutcome(written, null);
                }
            }

            if (DateTime.UtcNow < nextCheck)
            {
                continue;
            }

            nextCheck = DateTime.UtcNow + FailureCheck;

            if (RefusalNaming(name, timeout) is { } refusal)
            {
                return new ChainOutcome(string.Empty, refusal.Trim());
            }
        }

        Assert.Fail(
            $"no locator naming {name} reached {OutTopic} within {timeout.TotalMinutes:0} minutes, "
            + "and no step logged a refusal naming it. A schema rejection would look exactly like "
            + "this — its log line carries no file name — so read the lineage by ExecutionId before "
            + "concluding the chain is merely slow.");

        return new ChainOutcome(string.Empty, null);
    }

    /// <summary>
    /// What the chain did with one seeded file: the terminal locator, or the refusal that ended the
    /// run. Exactly one is meaningful, and which one is the assertion.
    /// </summary>
    private sealed record ChainOutcome(string Locator, string? Refusal);

    /// <summary>The first chain log line reporting a failure that names this file, or null.</summary>
    private static string? RefusalNaming(string name, TimeSpan since)
        => Capture("kubectl",
                $"logs -n {Namespace} -l \"{ChainSelector}\" --prefix "
                + $"--since={(int)since.TotalSeconds + 60}s --tail=2000 --max-log-requests=20")
            .Split('\n')
            .FirstOrDefault(line =>
                line.Contains(name, StringComparison.Ordinal)
                && (line.Contains("reported the step failed", StringComparison.Ordinal)
                    || line.Contains("failed:", StringComparison.Ordinal)));

    /// <summary>
    /// Builds an Acme bundle and copies it onto the node the FileFetcher pod mounts: one
    /// <c>.wav</c> and one <c>.json</c> SHARING A BASENAME, which is what makes them one item rather
    /// than two.
    /// </summary>
    private static string SeedBundle(string name)
    {
        var local = Path.Combine(Path.GetTempPath(), name);

        using (var file = File.Create(local))
        using (var archive = new ZipArchive(file, ZipArchiveMode.Create))
        {
            using (var wav = archive.CreateEntry("track01.wav").Open())
            {
                var pcm = SilentPcm(seconds: 0.5);
                wav.Write(pcm);
            }

            using var sidecar = new StreamWriter(archive.CreateEntry("track01.json").Open());
            sidecar.Write(JsonSerializer.Serialize(new
            {
                title = "Live Chain Probe",
                artist = "SKP Live Suite",
                album = "Live",
                recordedUtc = "2026-01-01T00:00:00Z",
                audio = new { file = "track01.wav", sampleRateHz = 44100, channels = 2, durationSeconds = 0.5 },
            }));
        }

        Run("docker", $"cp \"{local}\" {Node}:{NodeDir}/{name}");
        return $"{NodeDir}/{name}";
    }

    /// <summary>Builds an arbitrary archive and copies it onto the node, for the negative case.</summary>
    private static string SeedArchive(string name, params (string Entry, string Text)[] entries)
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
    /// Whether the out folder holds this name. <c>docker exec test -f</c> rather than
    /// <see cref="ReadBack"/>, which asserts on a non-zero exit and would fail the test with a
    /// <c>docker cp</c> error instead of answering the question.
    /// </summary>
    private static bool WrittenToOutFolder(string name)
    {
        using var process = Process.Start(new ProcessStartInfo(
            "docker", $"exec {Node} test -f {OutDir}/{name}") { RedirectStandardError = true })!;

        return process.WaitForExit(60_000) && process.ExitCode == 0;
    }

    /// <summary>
    /// A real 16-bit stereo PCM wav at 44.1kHz, silent.
    /// <para>
    /// <b>Real, because ffmpeg decodes it.</b> AcmeHandler checks only the extension and that the
    /// node carries bytes, so a fake would satisfy the handler — and then the conversion this test
    /// asserts would fail inside the pod, reported as a step failure with no obvious cause. Silence
    /// keeps it small; the assertions are about the encoding, not the sound.
    /// </para>
    /// </summary>
    private static byte[] SilentPcm(double seconds)
    {
        const int rate = 44100;
        const short channels = 2;
        const short bits = 16;

        var data = new byte[(int)(rate * seconds) * channels * (bits / 8)];
        var header = new MemoryStream();

        using (var w = new BinaryWriter(header, Encoding.ASCII, leaveOpen: true))
        {
            w.Write("RIFF"u8);
            w.Write(36 + data.Length);
            w.Write("WAVE"u8);
            w.Write("fmt "u8);
            w.Write(16);                                  // PCM subchunk size
            w.Write((short)1);                            // PCM, uncompressed
            w.Write(channels);
            w.Write(rate);
            w.Write(rate * channels * (bits / 8));        // byte rate
            w.Write((short)(channels * (bits / 8)));      // block align
            w.Write(bits);
            w.Write("data"u8);
            w.Write(data.Length);
        }

        return [.. header.ToArray(), .. data];
    }

    /// <summary>The bytes FilePersister wrote, copied off the node.</summary>
    private static byte[] ReadBack(string name)
    {
        var local = Path.Combine(Path.GetTempPath(), $"out-{name}");
        Run("docker", $"cp {Node}:{OutDir}/{name} \"{local}\"");
        return File.ReadAllBytes(local);
    }

    /// <summary>
    /// Produces with <c>ProduceAsync</c> and checks the delivery report, not <c>Produce</c> plus
    /// <c>Flush</c>: flush only proves the local queue drained, which stays silent whether the broker
    /// accepted the record or rejected it.
    /// </summary>
    private static async Task ProduceAsync(string path)
    {
        using var producer = new ProducerBuilder<Null, string>(
            new ProducerConfig { BootstrapServers = RealStack.KafkaBrokers }).Build();

        // filePath ALONE: file-locator declares additionalProperties: false, so a second key is
        // refused by KafkaImporter's own output validation and the lineage ends at the first hop.
        var result = await producer.ProduceAsync(RealStack.KafkaTopic, new Message<Null, string>
        {
            Value = JsonSerializer.Serialize(new { filePath = path }),
        });

        Assert.True(result.Status == PersistenceStatus.Persisted,
            $"produce to {RealStack.KafkaTopic} did not persist: status was {result.Status}");
    }

    /// <summary>
    /// Runs a command and waits for it to exit, on purpose not with the void overload of
    /// <c>WaitForExit</c>: that one blocks forever on a wedged child, and reading
    /// <see cref="Process.ExitCode"/> after a timed-out bool overload throws.
    /// </summary>
    private static void Run(string file, string arguments)
    {
        using var process = Process.Start(new ProcessStartInfo(file, arguments)
        {
            RedirectStandardError = true,
            // Not redirecting stdout: nothing here reads it, and a redirected pipe nobody drains is
            // a deadlock waiting for whichever command turns out to be chatty.
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
    /// Runs a command and returns its stdout. Drains the pipe BEFORE waiting — a full pipe blocks
    /// the child, and waiting first would deadlock on any output larger than the buffer.
    /// <c>kubectl logs</c> is exactly that chatty.
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
}
