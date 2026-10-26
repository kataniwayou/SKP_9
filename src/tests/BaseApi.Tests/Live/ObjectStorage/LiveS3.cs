using System.Diagnostics;
using System.IO.Compression;
using System.Text;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text.Json;
using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;
using Confluent.Kafka;
using Xunit;

namespace BaseApi.Tests.Live.ObjectStorage;

/// <summary>
/// What the three object-storage live classes share: an S3 client for a named MinIO user, seed /
/// read / delete helpers, and the Kafka and kubectl plumbing around them.
/// <para>
/// <b>Shared here, not copied per class</b> as the file-chain live classes do: those carry their own
/// copies of <c>Run</c>/<c>Capture</c> for historical reasons, and three more would be the drift the
/// convention's own comment warns about. The behaviour is the same as theirs (<c>ProduceAsync</c>
/// with a delivery report, stdout drained before the wait, a killed child on timeout).
/// </para>
/// <para>
/// The test may hold credentials; the processors may not. Every client is built with explicit
/// <see cref="BasicAWSCredentials"/> the way the processors build theirs (service URL, path-style,
/// signing region), so a signature that works here works there.
/// </para>
/// </summary>
internal static class LiveS3
{
    public const string In = "skp-in";
    public const string Out = "skp-out";

    public const string FetcherUser = "objectfetcher";
    public const string FetcherKey = "objectfetcher-dev-key";
    public const string PersisterUser = "objectpersister";
    public const string PersisterKey = "objectpersister-dev-key";

    private static string Namespace => RealStack.Get("SKP_NAMESPACE", "skp");

    /// <summary>One window for every wait, positive and negative; see FileFetcherLiveTests.Window.</summary>
    public static readonly TimeSpan Window = TimeSpan.FromMinutes(5);

    public static AmazonS3Client Client(string user, string secret) => new(
        new BasicAWSCredentials(user, secret),
        new AmazonS3Config
        {
            ServiceURL = RealStack.S3ServiceUrl,
            ForcePathStyle = true,
            AuthenticationRegion = "us-east-1",
        });

    public static AmazonS3Client Root() => Client(RealStack.S3RootUser, RealStack.S3RootPassword);

    public static async Task Seed(string bucket, string key, byte[] bytes)
    {
        using var s3 = Root();
        using var body = new MemoryStream(bytes);
        await s3.PutObjectAsync(
            new PutObjectRequest { BucketName = bucket, Key = key, InputStream = body },
            TestContext.Current.CancellationToken);
    }

    public static async Task<byte[]> Read(string bucket, string key)
    {
        using var s3 = Root();
        using var response = await s3.GetObjectAsync(bucket, key, TestContext.Current.CancellationToken);
        using var buffer = new MemoryStream();
        await response.ResponseStream.CopyToAsync(buffer, TestContext.Current.CancellationToken);
        return buffer.ToArray();
    }

    public static async Task<bool> Exists(string bucket, string key)
    {
        using var s3 = Root();
        try
        {
            await s3.GetObjectMetadataAsync(bucket, key, TestContext.Current.CancellationToken);
            return true;
        }
        catch (AmazonS3Exception e) when (e.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return false;
        }
    }

    /// <summary>Best effort: a cleanup that fails must not turn a passing test red or mask a real failure.</summary>
    public static async Task DeleteQuietly(IEnumerable<(string Bucket, string Key)> objects)
    {
        var list = objects.ToList();
        if (list.Count == 0)
        {
            return;
        }

        try
        {
            using var s3 = Root();
            foreach (var (bucket, key) in list)
            {
                try { await s3.DeleteObjectAsync(bucket, key); } catch { /* best effort */ }
            }
        }
        catch
        {
            // best effort
        }
    }

    /// <summary>Plain bytes of a given size: zeros, since only the length is under test.</summary>
    public static byte[] Bytes(long length) => new byte[length];

    /// <summary>
    /// Produces a locator alone to the object chain's input topic, checking the delivery report (a
    /// flush proves only that the local queue drained). <c>location</c> ALONE: the locator schema
    /// declares additionalProperties: false and the importer's own output validation refuses a second key.
    /// </summary>
    public static async Task ProduceAsync(string location)
    {
        using var producer = new ProducerBuilder<Null, string>(
            new ProducerConfig { BootstrapServers = RealStack.KafkaBrokers }).Build();

        var result = await producer.ProduceAsync(RealStack.ObjectTopic, new Message<Null, string>
        {
            Headers = LiveKafka.ExecutionHeaders(),
            Value = JsonSerializer.Serialize(new { location }),
        });

        Assert.True(result.Status == PersistenceStatus.Persisted,
            $"produce to {RealStack.ObjectTopic} did not persist: status was {result.Status}");
    }

    /// <summary>Runs a command and returns its stdout, UTF-8 (keys here carry non-ASCII). Drains before waiting.</summary>
    public static string Capture(string file, string arguments)
    {
        using var process = Process.Start(new ProcessStartInfo(file, arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
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

    /// <summary>A deployment's recent log lines across its replicas, pod-prefixed.</summary>
    public static string PodLog(string deployment, TimeSpan since)
        => Capture("kubectl",
            $"logs -n {Namespace} deployment/{deployment} --all-containers --prefix "
            + $"--since={(int)since.TotalSeconds}s --tail=2000");

    /// <summary>Polls a deployment's log for <paramref name="needle"/>; the log store and the topic are not ordered.</summary>
    public static bool LogContains(string deployment, string needle, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        var window = timeout + TimeSpan.FromMinutes(1);

        while (DateTime.UtcNow < deadline)
        {
            if (PodLog(deployment, window).Contains(needle, StringComparison.Ordinal))
            {
                return true;
            }

            Thread.Sleep(5_000);
        }

        return false;
    }

    /// <summary>
    /// The first chain log line reporting a failure that names this file, or null. The object pair
    /// replaces the file pair in the selector; the shared expander, normalizer, collapser, importer
    /// and exporter are the same pods the file chain uses.
    /// </summary>
    public static string? RefusalNaming(string name, TimeSpan since)
        => Capture("kubectl",
                $"logs -n {Namespace} -l \"{ChainSelector}\" --prefix "
                + $"--since={(int)since.TotalSeconds + 60}s --tail=2000 --max-log-requests=20")
            .Split('\n')
            .FirstOrDefault(line =>
                line.Contains(name, StringComparison.Ordinal)
                && (line.Contains("reported the step failed", StringComparison.Ordinal)
                    || line.Contains("failed:", StringComparison.Ordinal)));

    private const string ChainSelector =
        "app in (processor-kafkaimporter,processor-objectfetcher,processor-archiveexpander,"
        + "processor-sknormalizer,processor-archivecollapser,processor-objectpersister,"
        + "processor-kafkaexporter)";

    /// <summary>
    /// An Acme bundle (one .wav and one .json sharing a basename), the same bytes ChainLiveTests
    /// seeds: the normalizer in the chain accepts nothing else.
    /// </summary>
    public static byte[] AcmeBundle()
    {
        using var buffer = new MemoryStream();
        using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            using (var wav = archive.CreateEntry("track01.wav").Open())
            {
                wav.Write(SilentPcm(seconds: 0.5));
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

        return buffer.ToArray();
    }

    /// <summary>A real 16-bit stereo 44.1kHz silent wav: ffmpeg must be able to decode it.</summary>
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
            w.Write(16);
            w.Write((short)1);
            w.Write(channels);
            w.Write(rate);
            w.Write(rate * channels * (bits / 8));
            w.Write((short)(channels * (bits / 8)));
            w.Write(bits);
            w.Write("data"u8);
            w.Write(data.Length);
        }

        return [.. header.ToArray(), .. data];
    }

    /// <summary>
    /// A processor assembly's source hash, read from the file's metadata WITHOUT loading it.
    /// <para>
    /// Reflection on the type would be the obvious route and is what the file-chain live tests use,
    /// but loading is exactly what Windows App Control refuses on this dev machine for some freshly
    /// built processor assemblies ("An Application Control policy has blocked this file"), and a
    /// metadata read needs no execution rights. The attribute is the same one
    /// <c>SourceHash.targets</c> emits; only the way of reading it differs.
    /// </para>
    /// </summary>
    public static string SourceHashOf(string assemblyFileName)
    {
        using var stream = File.OpenRead(Path.Combine(AppContext.BaseDirectory, assemblyFileName));
        using var pe = new PEReader(stream);
        var md = pe.GetMetadataReader();

        foreach (var handle in md.GetAssemblyDefinition().GetCustomAttributes())
        {
            var attribute = md.GetCustomAttribute(handle);
            if (attribute.Constructor.Kind != HandleKind.MemberReference)
            {
                continue;
            }

            var parent = md.GetMemberReference((MemberReferenceHandle)attribute.Constructor).Parent;
            if (parent.Kind != HandleKind.TypeReference
                || md.GetString(md.GetTypeReference((TypeReferenceHandle)parent).Name) != "AssemblyMetadataAttribute")
            {
                continue;
            }

            // Blob: 0x0001 prolog, then two serialized strings (key, value).
            var blob = md.GetBlobReader(attribute.Value);
            blob.ReadUInt16();
            var key = blob.ReadSerializedString();
            var value = blob.ReadSerializedString();
            if (key == "SourceHash")
            {
                return value!;
            }
        }

        throw new InvalidOperationException($"{assemblyFileName} carries no SourceHash metadata");
    }

    /// <summary>The processor row for a source hash, parsed, or a failing assertion saying the row is missing.</summary>
    public static async Task<JsonElement> ProcessorRow(string sourceHash)
    {
        using var client = new HttpClient { BaseAddress = new Uri(RealStack.BaseApiUrl) };
        var response = await client.GetAsync(
            $"/api/v1/processors/by-source-hash/{sourceHash}", TestContext.Current.CancellationToken);

        Assert.True(response.IsSuccessStatusCode,
            $"no processor row for source hash {sourceHash} ({(int)response.StatusCode}) - the image "
            + "was rebuilt without repointing the row, or the row was never registered");

        return JsonDocument.Parse(
            await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken)).RootElement;
    }

    public static string? Id(JsonElement row, string property)
        => row.TryGetProperty(property, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}
