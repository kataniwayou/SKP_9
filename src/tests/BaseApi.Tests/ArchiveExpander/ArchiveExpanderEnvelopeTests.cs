using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.ArchiveExpander;
using Xunit;

namespace BaseApi.Tests.ArchiveExpander;

/// <summary>
/// The input branch, which is now an envelope rather than a path. Every failure is a business
/// failure with a diagnosis, and none quotes the fragment that failed to parse.
/// </summary>
public sealed class ArchiveExpanderEnvelopeTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private const string Payload = """{"MaxDepth":1}""";

    private static ArchiveExpanderProcessor Build()
    {
        var processor = new ArchiveExpanderProcessor(
            new RecordingLogger<ArchiveExpanderProcessor>(),
            new FileContentBuilder([], Options.Create(new ArchiveExpanderOptions())));
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

        Assert.StartsWith("input branch did not carry a fetched file: ", message,
                          StringComparison.Ordinal);
        Assert.Contains("the branch is not JSON", message, StringComparison.Ordinal);
        Assert.DoesNotContain("not json at all", message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnEnvelopeWithNoFileNameFails()
    {
        var message = await FailureFor(Encoding.UTF8.GetBytes(
            """{"extension":".csv","sizeBytes":2,"createdUtc":null,"modifiedUtc":null,"content":"aWQ="}"""));

        Assert.Contains("the branch carries no fileName", message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnEnvelopeWithNoContentFails()
    {
        var message = await FailureFor(Encoding.UTF8.GetBytes(
            """{"fileName":"a.csv","extension":".csv","sizeBytes":2,"createdUtc":null,"modifiedUtc":null}"""));

        Assert.Contains("the branch carries no content", message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnAbsentPayloadFailsTheStep()
    {
        var processor = Build();

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => processor.ExecuteAsync([], "", E, CancellationToken.None));

        Assert.StartsWith("step payload rejected: ", ex.Message, StringComparison.Ordinal);
        Assert.Contains("needs MaxDepth", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnExplicitZeroDepthIsRejected()
    {
        // Absent means 1, via the record's own default parameter value. An explicit 0 means the
        // payload SAID zero, and that is far more likely to be a payload written against the wrong
        // field than a request for no expansion.
        var processor = Build();

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => processor.ExecuteAsync(
                Encoding.UTF8.GetBytes(
                    """{"fileName":"a.csv","extension":".csv","sizeBytes":2,"createdUtc":null,"modifiedUtc":null,"content":"aWQ="}"""),
                """{"MaxDepth":0}""", E, CancellationToken.None));

        // The bound comes from the constant, not a literal: this assertion was written as "1 and 64"
        // and went red when MaxSupportedDepth was lowered to 10, which is the constant doing its job
        // rather than a contract change. The message shape is what this test is about.
        Assert.Contains(
            $"MaxDepth must be between 1 and {ArchiveExpanderConfig.MaxSupportedDepth}",
            ex.Message,
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnOmittedDepthIsOne()
    {
        // No throw is the assertion: an omitted MaxDepth must not arrive as default(int) and be
        // rejected as zero.
        var processor = Build();

        await processor.ExecuteAsync(
            Encoding.UTF8.GetBytes(
                """{"fileName":"a.csv","extension":".csv","sizeBytes":2,"createdUtc":null,"modifiedUtc":null,"content":"aWQ="}"""),
            "{}", E, CancellationToken.None);
    }
}
