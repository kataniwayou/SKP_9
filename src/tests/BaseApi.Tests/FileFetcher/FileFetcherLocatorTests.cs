using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.FileFetcher;
using Xunit;

namespace BaseApi.Tests.FileFetcher;

/// <summary>
/// The input branch. Every failure here is a business failure with a diagnosis, never a framework
/// exception with a sanitized message — and none of them quotes the fragment that failed to parse,
/// because that fragment is upstream content.
/// </summary>
public sealed class FileFetcherLocatorTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private const string Payload =
        """{"AllowedExtensions":[".csv"],"MinimumSizeBytes":0,"MaximumSizeBytes":4096}""";

    private static FileFetcherProcessor Build()
    {
        var processor = new FileFetcherProcessor(
            new RecordingLogger<FileFetcherProcessor>(),
            Options.Create(new FileFetcherOptions()));
        processor.BeginDispatch(new DispatchState(Substitute.For<IQueueSender>(), C, W, S, P));
        return processor;
    }

    private static async Task<string> FailureFor(byte[] branch)
    {
        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Build().ExecuteAsync(branch, Payload, E, CancellationToken.None));
        return ex.Message;
    }

    [Fact]
    public async Task ABranchThatIsNotJsonFailsWithoutQuotingIt()
    {
        var message = await FailureFor(Encoding.UTF8.GetBytes("not json at all"));

        Assert.StartsWith("input branch did not name a file path: ", message, StringComparison.Ordinal);
        Assert.Contains("the branch is not JSON", message, StringComparison.Ordinal);
        Assert.DoesNotContain("not json at all", message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ABranchWithNoFilePathFails()
    {
        var message = await FailureFor(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { providerName = "acme" })));

        Assert.Contains("the branch carries no filePath", message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ARelativePathFails()
    {
        // IsPathFullyQualified, not IsPathRooted: on Windows a drive-relative path such as
        // "\orders.csv" is rooted but not absolute — it resolves against whatever drive is current,
        // which is not a location any workflow author chose.
        var message = await FailureFor(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { filePath = "orders.csv" })));

        Assert.Contains("the path is relative", message, StringComparison.Ordinal);
    }
}
