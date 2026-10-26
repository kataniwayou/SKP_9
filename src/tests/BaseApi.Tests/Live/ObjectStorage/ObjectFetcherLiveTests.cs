using Xunit;

namespace BaseApi.Tests.Live.ObjectStorage;

/// <summary>
/// The half of the ObjectFetcher to ArchiveExpander chain only a real S3 can answer: the signature
/// over a key with spaces, plus, percent and non-ASCII characters; the HEAD-before-GET size and
/// extension guards against real object metadata; the 404 and the filesystem-path refusals; and the
/// processor's own log line. The hermetic suite fakes <c>IAmazonS3</c>, which is exactly why none of
/// that is proven there.
/// <para>
/// Needs <c>SKP_REALSTACK=1</c>, the kind cluster with the object chain deployed, and the
/// <c>skp-minio</c> and <c>skp-kafka</c> containers. Every test seeds under <c>skp-in/live/</c> and
/// deletes what it seeded; the assertion is the fetcher's log line, as in FileFetcherLiveTests.
/// </para>
/// </summary>
/// <remarks>
/// Shares the <c>kafka-broker</c> collection with the other live classes that stop and start the
/// shared Kafka container, so this class never runs while the broker is down.
/// </remarks>
[Trait("Category", RealStack.Category)]
[Collection("kafka-broker")]
public sealed class ObjectFetcherLiveTests : IAsyncLifetime
{
    private const string Deployment = "processor-objectfetcher";
    private static readonly TimeSpan Window = LiveS3.Window;
    private readonly List<(string Bucket, string Key)> _seeded = [];

    public ValueTask InitializeAsync() => ValueTask.CompletedTask;

    public async ValueTask DisposeAsync() => await LiveS3.DeleteQuietly(_seeded);

    private async Task<string> Seed(string key, byte[] bytes)
    {
        _seeded.Add((LiveS3.In, key));
        await LiveS3.Seed(LiveS3.In, key, bytes);
        return $"s3://{LiveS3.In}/{key}";
    }

    // Read from the built assembly so it is never a stale literal; see LiveS3.SourceHashOf for why not reflection.
    private static string SourceHash => LiveS3.SourceHashOf("Processor.ObjectFetcher.dll");

    /// <summary>
    /// An Acme bundle that is fetched is also persisted by the rest of the chain, so its skp-out copy
    /// is this test's to remove -- but only once it exists, or the delete races the write and leaves
    /// the object behind. Waits (bounded by the shared window) and then tracks it for cleanup.
    /// </summary>
    private async Task AwaitPersistedThenTrack(string name)
    {
        _seeded.Add((LiveS3.Out, name));

        var deadline = DateTime.UtcNow + Window;
        while (DateTime.UtcNow < deadline && !await LiveS3.Exists(LiveS3.Out, name))
        {
            await Task.Delay(3_000, TestContext.Current.CancellationToken);
        }
    }

    [Fact]
    public async Task ASeededObjectIsFetched()
    {
        RealStack.SkipUnlessEnabled();

        var name = $"orders-{Guid.NewGuid():N}.zip";
        var location = await Seed($"live/{name}", LiveS3.AcmeBundle());

        await LiveS3.ProduceAsync(location);

        Assert.True(
            LiveS3.LogContains(Deployment, $"fetched {name} (.zip)", Window),
            $"no 'fetched {name} (.zip)' line reached the ObjectFetcher log within {Window.TotalMinutes:0} minutes");

        await AwaitPersistedThenTrack(name);
    }

    [Fact]
    public async Task AKeyWithSpacesPlusPercentAndUnicodeIsFetched()
    {
        RealStack.SkipUnlessEnabled();

        // The key must reach HEAD and GET byte for byte. A space, a plus and a literal "%20" each
        // survive or die differently in URL encoding and in SigV4 canonicalisation, and only a real
        // S3 verifying the signature can say which. "%20" here is three characters, not a space.
        var name = $"a b+c%20ü-{Guid.NewGuid():N}.zip";
        var location = await Seed($"live/{name}", LiveS3.AcmeBundle());

        await LiveS3.ProduceAsync(location);

        Assert.True(
            LiveS3.LogContains(Deployment, $"fetched {name} (.zip)", Window),
            $"no 'fetched {name} (.zip)' line within {Window.TotalMinutes:0} minutes - "
            + "the key was altered between the record and the signed request");

        await AwaitPersistedThenTrack(name);
    }

    [Fact]
    public async Task AMissingObjectFailsByName()
    {
        RealStack.SkipUnlessEnabled();

        var location = $"s3://{LiveS3.In}/live/missing-{Guid.NewGuid():N}.zip";

        await LiveS3.ProduceAsync(location);

        Assert.True(
            LiveS3.LogContains(Deployment, $"reading {location} failed: it does not exist (bucket or key)", Window),
            $"no 'reading {location} failed' line within {Window.TotalMinutes:0} minutes");
    }

    [Fact]
    public async Task AnOversizeObjectIsRejectedDry()
    {
        RealStack.SkipUnlessEnabled();

        // One byte over the manifest's 33554432 ceiling. "Dry" because the HEAD's Content-Length
        // decides: the body is never fetched, which is what keeps the pod's memory bounded.
        var name = $"big-{Guid.NewGuid():N}.zip";
        var location = await Seed($"live/{name}", LiveS3.Bytes(33_554_433));

        await LiveS3.ProduceAsync(location);

        Assert.True(
            LiveS3.LogContains(Deployment,
                $"object {location} rejected: 33554433 bytes is above the 33554432 byte ceiling", Window),
            $"no oversize rejection naming {location} within {Window.TotalMinutes:0} minutes");
    }

    [Fact]
    public async Task AWrongExtensionIsRejected()
    {
        RealStack.SkipUnlessEnabled();

        var name = $"orders-{Guid.NewGuid():N}.dat";
        var location = await Seed($"live/{name}", [1, 2, 3]);

        await LiveS3.ProduceAsync(location);

        Assert.True(
            LiveS3.LogContains(Deployment,
                $"object {location} rejected: extension '.dat' is not in the allowed list (.zip)", Window),
            $"no extension rejection naming {location} within {Window.TotalMinutes:0} minutes");
    }

    [Fact]
    public async Task AFilesystemPathIsRefusedAsFileFetchers()
    {
        RealStack.SkipUnlessEnabled();

        // A path is a location this processor cannot open, and the refusal says whose it is. The
        // location is upstream content and deliberately NOT in the message, so the line cannot be
        // attributed to this dispatch: the wording appearing within the window is what is asserted.
        await LiveS3.ProduceAsync($"/mnt/skp-files/in/x-{Guid.NewGuid():N}.zip");

        const string refusal = "input branch did not name a location this processor reads:";

        Assert.True(
            LiveS3.LogContains(Deployment, refusal, Window),
            "no filesystem-path refusal reached the ObjectFetcher log");

        var line = LiveS3.PodLog(Deployment, Window + TimeSpan.FromMinutes(1))
            .Split('\n').First(l => l.Contains(refusal, StringComparison.Ordinal));

        Assert.Contains("FileFetcher's", line, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheProcessorRowIsRegistered()
    {
        RealStack.SkipUnlessEnabled();

        var row = await LiveS3.ProcessorRow(SourceHash);

        // locator in, file-envelope out, and a config schema: a null on any of the three means the
        // schema enforces nothing there, and a document arriving is then no evidence it was applied.
        Assert.Equal("95aa9da6-4c35-412c-9f67-0183f36739d7", LiveS3.Id(row, "inputSchemaId"));
        Assert.Equal("85f9c137-e254-4e3e-acc6-63b7e6f5c3cc", LiveS3.Id(row, "outputSchemaId"));
        Assert.NotNull(LiveS3.Id(row, "configSchemaId"));
    }
}
