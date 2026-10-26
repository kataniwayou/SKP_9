using System.IO.Compression;
using System.Text;
using System.Text.Json;
using Confluent.Kafka;
using Xunit;

namespace BaseApi.Tests.Live.ObjectStorage;

/// <summary>
/// THE WHOLE OBJECT CHAIN, END TO END: a bundle seeded into <c>skp-in</c> is fetched by
/// ObjectFetcher, expanded, normalized by SKNormalizer (Acme), collapsed, written to <c>skp-out</c>
/// by ObjectPersister, and its <c>s3://</c> locator published by the exporter. The twin of
/// <c>ChainLiveTests</c> with the node mount replaced by MinIO; the input is an Acme bundle for the
/// same reason (the normalizer refuses anything else) and the output is asserted as the same
/// TRANSFORMATION, not an identity.
/// <para>
/// Like ChainLiveTests it fails fast: a step logging a refusal that names the file ends the wait in
/// seconds, quoting the line, instead of costing the window. A schema rejection (no file name in
/// its text) still falls through to the window.
/// </para>
/// </summary>
[Trait("Category", RealStack.Category)]
[Collection("kafka-broker")]
public sealed class ObjectChainLiveTests : IAsyncLifetime
{
    private static readonly TimeSpan Window = LiveS3.Window;
    private static readonly TimeSpan FailureCheck = TimeSpan.FromSeconds(15);
    private readonly List<(string Bucket, string Key)> _seeded = [];

    public ValueTask InitializeAsync() => ValueTask.CompletedTask;

    public async ValueTask DisposeAsync() => await LiveS3.DeleteQuietly(_seeded);

    [Fact]
    public async Task AnAcmeBundleTraversesTheObjectChain()
    {
        RealStack.SkipUnlessEnabled();

        var name = $"acme-{Guid.NewGuid():N}.zip";
        var written = await RoundTrip(name);

        Assert.Equal($"s3://{LiveS3.Out}/{name}", written);

        using var archive = new ZipArchive(new MemoryStream(await LiveS3.Read(LiveS3.Out, name)), ZipArchiveMode.Read);

        // NOT the entries that went in: the sidecar became XML and the audio was re-encoded.
        Assert.Equal(["track01.mp3", "track01.xml"], archive.Entries.Select(e => e.Name).Order().ToArray());

        // The bytes were really replaced, not renamed: ffmpeg writes an ID3 header, the seeded wav "RIFF".
        var audio = new byte[3];
        using (var stream = archive.Entries.Single(e => e.Name == "track01.mp3").Open())
        {
            Assert.Equal(3, stream.ReadAtLeast(audio, 3, throwOnEndOfStream: false));
        }

        Assert.Equal("ID3", Encoding.ASCII.GetString(audio));

        var xml = new StreamReader(archive.Entries.Single(e => e.Name == "track01.xml").Open()).ReadToEnd();

        Assert.Contains("<provider>Acme</provider>", xml, StringComparison.Ordinal);
        Assert.Contains("<originalName>track01.json</originalName>", xml, StringComparison.Ordinal);
        Assert.Contains("<fileName>track01.mp3</fileName>", xml, StringComparison.Ordinal);
        Assert.Contains("<codec>mp3</codec>", xml, StringComparison.Ordinal);
        Assert.Contains("<bitrateKbps>192</bitrateKbps>", xml, StringComparison.Ordinal);
        Assert.Contains("<sampleRateHz>44100</sampleRateHz>", xml, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnOddlyNamedBundleComesBackUnderTheSameName()
    {
        RealStack.SkipUnlessEnabled();

        // The name survives fetch, expand, normalize, collapse, persist and publish untouched: the
        // published location is the literal key, and the object exists in skp-out under exactly it.
        var name = $"a b+c%20ü-{Guid.NewGuid():N}.zip";
        var written = await RoundTrip(name);

        Assert.Equal($"s3://{LiveS3.Out}/{name}", written);
        Assert.True(await LiveS3.Exists(LiveS3.Out, name),
            $"the chain published {written} but skp-out holds no object under exactly that key");
    }

    /// <summary>Seeds the bundle, produces its locator, and returns the locator the chain published for it.</summary>
    private async Task<string> RoundTrip(string name)
    {
        _seeded.Add((LiveS3.In, $"live/{name}"));
        _seeded.Add((LiveS3.Out, name));
        await LiveS3.Seed(LiveS3.In, $"live/{name}", LiveS3.AcmeBundle());

        await LiveS3.ProduceAsync($"s3://{LiveS3.In}/live/{name}");

        var outcome = AwaitOutcome(name, Window);
        Assert.Null(outcome.Refusal);
        return outcome.Locator;
    }

    private static ChainOutcome AwaitOutcome(string name, TimeSpan timeout)
    {
        using var consumer = new ConsumerBuilder<Ignore, string>(new ConsumerConfig
        {
            BootstrapServers = RealStack.KafkaBrokers,
            GroupId = $"live-objectchain-{Guid.NewGuid():N}",
            AutoOffsetReset = AutoOffsetReset.Earliest,
        }).Build();

        consumer.Subscribe(RealStack.ObjectOutTopic);

        var deadline = DateTime.UtcNow + timeout;
        var nextCheck = DateTime.UtcNow + FailureCheck;

        while (DateTime.UtcNow < deadline)
        {
            var result = consumer.Consume(TimeSpan.FromSeconds(5));

            if (result?.Message?.Value is { Length: > 0 } value)
            {
                var root = JsonDocument.Parse(value).RootElement;

                // The terminal shape is a locator, matched on the key (the persister's destination
                // is a bucket root, so the key is the whole name).
                if (root.TryGetProperty("location", out var location)
                    && location.GetString() is { Length: > 0 } written
                    && written.EndsWith("/" + name, StringComparison.Ordinal))
                {
                    return new ChainOutcome(written, null);
                }
            }

            if (DateTime.UtcNow < nextCheck)
            {
                continue;
            }

            nextCheck = DateTime.UtcNow + FailureCheck;

            if (LiveS3.RefusalNaming(name, timeout) is { } refusal)
            {
                return new ChainOutcome(string.Empty, refusal.Trim());
            }
        }

        Assert.Fail(
            $"no locator naming {name} reached {RealStack.ObjectOutTopic} within {timeout.TotalMinutes:0} minutes, "
            + "and no step logged a refusal naming it (a schema rejection looks exactly like this).");

        return new ChainOutcome(string.Empty, null);
    }

    private sealed record ChainOutcome(string Locator, string? Refusal);
}
