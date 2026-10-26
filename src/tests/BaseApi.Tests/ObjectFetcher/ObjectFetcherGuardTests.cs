using System.Text;
using System.Text.Json;
using Amazon.S3;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.ObjectFetcher;
using Xunit;

namespace BaseApi.Tests.ObjectFetcher;

/// <summary>
/// The checks that need no S3 at all: the payload and the input branch. Every one of these must fail
/// before the first request, so the substituted client must record no call. Each failure is a
/// business failure with a diagnosis, and none of them quotes the fragment that failed to parse,
/// because that fragment is upstream content.
/// </summary>
public sealed class ObjectFetcherGuardTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private const string Location = "s3://skp-in/feeds/a.csv";

    private const string CsvPayload =
        """{"AllowedExtensions":[".csv"],"MinimumSizeBytes":0,"MaximumSizeBytes":4096}""";

    private readonly IAmazonS3 _s3 = Substitute.For<IAmazonS3>();

    private ObjectFetcherProcessor Build(long podCeiling = 33_554_432)
    {
        var processor = new ObjectFetcherProcessor(
            new RecordingLogger<ObjectFetcherProcessor>(),
            Options.Create(new ObjectFetcherOptions { MaxObjectSizeBytes = podCeiling }),
            _s3);
        processor.BeginDispatch(TestDispatch.State(Substitute.For<IQueueSender>(), C, W, S, P));
        return processor;
    }

    private static string Payload(string[]? extensions, long min, long max)
        => JsonSerializer.Serialize(new
        {
            AllowedExtensions = extensions,
            MinimumSizeBytes = min,
            MaximumSizeBytes = max,
        });

    private static byte[] Branch(string location)
        => Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { location }));

    private async Task<string> PayloadFailure(string payload, long podCeiling = 33_554_432)
    {
        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Build(podCeiling).ExecuteAsync(Branch(Location), payload, E, CancellationToken.None));

        Assert.Empty(_s3.ReceivedCalls());
        return ex.Message;
    }

    private async Task<string> BranchFailure(byte[] branch)
    {
        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Build().ExecuteAsync(branch, CsvPayload, E, CancellationToken.None));

        Assert.Empty(_s3.ReceivedCalls());
        return ex.Message;
    }

    [Fact]
    public async Task AnAbsentPayloadFailsTheStep()
    {
        // An absent payload IS a malformed payload, and it shares the prefix so one query finds
        // every payload fault including the commonest one.
        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Build().ExecuteAsync([], "", E, CancellationToken.None));

        Assert.StartsWith("step payload rejected: ", ex.Message, StringComparison.Ordinal);
        Assert.Contains("needs AllowedExtensions", ex.Message, StringComparison.Ordinal);
        Assert.Empty(_s3.ReceivedCalls());
    }

    [Fact]
    public async Task AMalformedExtensionEntryIsQuotedBack()
    {
        var message = await PayloadFailure(Payload([".zip", "zip"], 0, 4096));

        Assert.StartsWith("step payload rejected: ", message, StringComparison.Ordinal);
        Assert.Contains("'zip'", message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ANullExtensionEntryFailsAsAPayloadRejectionNotAFault()
    {
        // The list comes from JsonSerializer.Deserialize, which places a JSON null into a non-nullable
        // element type without complaint. It must surface through the documented contract, not as an
        // unhandled NullReferenceException logged as a faulted transform.
        var message = await PayloadFailure(
            """{"AllowedExtensions":[".zip", null],"MinimumSizeBytes":0,"MaximumSizeBytes":4096}""");

        Assert.StartsWith("step payload rejected: ", message, StringComparison.Ordinal);
        Assert.Contains("'null'", message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task APayloadCeilingAboveThePodCeilingFailsTheStep()
    {
        // Not clamped. Clamping means the author asked for 100MB, got failures at 32, and nothing
        // said why.
        var message = await PayloadFailure(Payload([".csv"], 0, 4096), podCeiling: 1024);

        Assert.StartsWith("step payload rejected: ", message, StringComparison.Ordinal);
        Assert.Contains("above this pod's ceiling", message, StringComparison.Ordinal);
        Assert.Contains("ObjectFetcher__MaxObjectSizeBytes", message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ANegativeFloorFailsTheStep()
    {
        var message = await PayloadFailure(Payload([".csv"], -1, 4096));

        Assert.Contains("MinimumSizeBytes must not be negative", message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ACeilingBelowOneFailsTheStep()
    {
        var message = await PayloadFailure(Payload([".csv"], 0, 0));

        Assert.Contains("MaximumSizeBytes must be at least 1", message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AFloorAboveTheCeilingFailsTheStep()
    {
        var message = await PayloadFailure(Payload([".csv"], 4096, 100));

        Assert.Contains("is above MaximumSizeBytes", message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ABranchThatIsNotJsonFailsWithoutQuotingIt()
    {
        var message = await BranchFailure(Encoding.UTF8.GetBytes("not json at all"));

        Assert.StartsWith("input branch did not name a location: ", message, StringComparison.Ordinal);
        Assert.Contains("the branch is not JSON", message, StringComparison.Ordinal);
        Assert.DoesNotContain("not json at all", message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ABranchWithNoLocationFails()
    {
        var message = await BranchFailure(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { providerName = "acme" })));

        Assert.StartsWith("input branch did not name a location: ", message, StringComparison.Ordinal);
        Assert.Contains("the branch carries no location", message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AFilesystemPathIsRefusedAsFileFetchers()
    {
        // One locator shape serves both pairs; a location this processor cannot open must say whose
        // it is rather than fall through to "malformed".
        var message = await BranchFailure(Branch("/mnt/skp-files/in/a.zip"));

        Assert.StartsWith(
            "input branch did not name a location this processor reads:", message, StringComparison.Ordinal);
        Assert.Contains("FileFetcher's", message, StringComparison.Ordinal);
        Assert.DoesNotContain("/mnt/skp-files", message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ABadBucketIsQuotedAndTheFullLocationIsNot()
    {
        var message = await BranchFailure(Branch("s3://Skp-In/secret/a.csv"));

        Assert.StartsWith("input branch did not name a location: ", message, StringComparison.Ordinal);
        Assert.Contains("'Skp-In'", message, StringComparison.Ordinal);
        Assert.DoesNotContain("secret", message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("s3://skp-in/", "names no object")]
    [InlineData("s3://skp-in/dir/", "names a folder")]
    public async Task ALocationThatNamesNoObjectFails(string location, string expected)
    {
        var message = await BranchFailure(Branch(location));

        Assert.StartsWith("input branch did not name a location: ", message, StringComparison.Ordinal);
        Assert.Contains(expected, message, StringComparison.Ordinal);
    }
}
