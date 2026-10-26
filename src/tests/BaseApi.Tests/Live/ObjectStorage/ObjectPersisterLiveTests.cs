using System.Net;
using Amazon.S3;
using Amazon.S3.Model;
using Xunit;

namespace BaseApi.Tests.Live.ObjectStorage;

/// <summary>
/// What only the real MinIO can say about the persister: its processor row, and that each of the two
/// users is refused everything but its own job. The write path end to end is
/// <see cref="ObjectChainLiveTests"/>; this is spec section 13's "a destination in skp-in fails 403",
/// proven at the policy with direct SDK calls rather than through a second workflow.
/// </summary>
[Trait("Category", RealStack.Category)]
[Collection("kafka-broker")]
public sealed class ObjectPersisterLiveTests : IAsyncLifetime
{
    private readonly List<(string Bucket, string Key)> _seeded = [];

    public ValueTask InitializeAsync() => ValueTask.CompletedTask;

    public async ValueTask DisposeAsync() => await LiveS3.DeleteQuietly(_seeded);

    // Read from the built assembly so it is never a stale literal; see LiveS3.SourceHashOf for why not reflection.
    private static string SourceHash => LiveS3.SourceHashOf("Processor.ObjectPersister.dll");

    [Fact]
    public async Task TheProcessorRowIsRegistered()
    {
        RealStack.SkipUnlessEnabled();

        var row = await LiveS3.ProcessorRow(SourceHash);

        Assert.Equal("85f9c137-e254-4e3e-acc6-63b7e6f5c3cc", LiveS3.Id(row, "inputSchemaId"));
        Assert.Equal("95aa9da6-4c35-412c-9f67-0183f36739d7", LiveS3.Id(row, "outputSchemaId"));
        Assert.NotNull(LiveS3.Id(row, "configSchemaId"));
    }

    [Fact]
    public async Task EachUserIsRefusedEverythingButItsOwnJob()
    {
        RealStack.SkipUnlessEnabled();

        var ct = TestContext.Current.CancellationToken;
        var key = $"live/policy-{Guid.NewGuid():N}.zip";
        _seeded.Add((LiveS3.In, key));
        await LiveS3.Seed(LiveS3.In, key, [1, 2, 3]);

        using var persister = LiveS3.Client(LiveS3.PersisterUser, LiveS3.PersisterKey);
        using var fetcher = LiveS3.Client(LiveS3.FetcherUser, LiveS3.FetcherKey);

        // Keys of the writes that SHOULD be refused are tracked too: a policy hole would otherwise
        // leave the object behind.
        PutObjectRequest Put(string bucket)
        {
            var denied = $"live/denied-{Guid.NewGuid():N}.zip";
            _seeded.Add((bucket, denied));
            return new PutObjectRequest { BucketName = bucket, Key = denied, InputStream = new MemoryStream([9]) };
        }

        // The persister may write skp-out only: a destinationUri in skp-in is refused by the store.
        await AssertDenied(() => persister.PutObjectAsync(Put(LiveS3.In), ct));

        // ...and it may not read skp-out back, or anything else.
        await AssertDenied(() => persister.GetObjectAsync(LiveS3.Out, key, ct));

        // The fetcher may read skp-in only: it cannot write there either.
        await AssertDenied(() => fetcher.PutObjectAsync(Put(LiveS3.In), ct));

        // And it can read: a policy that denied this too would make every denial above meaningless.
        using var ok = await fetcher.GetObjectAsync(LiveS3.In, key, ct);
        Assert.Equal(HttpStatusCode.OK, ok.HttpStatusCode);
    }

    private static async Task AssertDenied(Func<Task> call)
    {
        var ex = await Assert.ThrowsAsync<AmazonS3Exception>(call);
        Assert.Equal(HttpStatusCode.Forbidden, ex.StatusCode);
        Assert.Equal("AccessDenied", ex.ErrorCode);
    }
}
