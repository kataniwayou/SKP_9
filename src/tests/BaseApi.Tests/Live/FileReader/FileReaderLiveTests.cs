using System.Diagnostics;
using System.IO.Compression;
using System.Text.Json;
using Confluent.Kafka;
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
}
