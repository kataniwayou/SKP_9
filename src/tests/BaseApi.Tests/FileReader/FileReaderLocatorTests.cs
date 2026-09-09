using System.Text;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.FileReader;
using Xunit;

namespace BaseApi.Tests.FileReader;

public sealed class FileReaderLocatorTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private const string Payload =
        """{"ExpectedExtension":".csv","MinimumSizeBytes":0,"MaximumSizeBytes":1024}""";

    private static (FileReaderProcessor Processor, RecordingLogger<FileReaderProcessor> Log) Build()
    {
        var log = new RecordingLogger<FileReaderProcessor>();
        var processor = new FileReaderProcessor(
            log, Options.Create(new FileReaderOptions()), new FileContentBuilder([]));
        processor.BeginDispatch(new DispatchState(Substitute.For<IQueueSender>(), C, W, S, P));
        return (processor, log);
    }

    private static Task Run(FileReaderProcessor processor, string json)
        => processor.ExecuteAsync(Encoding.UTF8.GetBytes(json), Payload, E, CancellationToken.None);

    [Fact]
    public async Task AnInputThatIsNotJsonFailsTheStep()
    {
        var (processor, _) = Build();

        var ex = await Assert.ThrowsAsync<FailedException>(() => Run(processor, "not json"));

        Assert.Contains("did not name a file path", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnInputWithNoFilePathFailsTheStep()
    {
        var (processor, _) = Build();

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, """{"providerName":"acme"}"""));

        Assert.Contains("did not name a file path", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ARelativePathFailsTheStep()
    {
        // The contract is an ABSOLUTE path. A relative one would resolve against the pod's working
        // directory, which is not a location any workflow author chose.
        var (processor, _) = Build();

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, """{"filePath":"orders.csv"}"""));

        Assert.Contains("did not name a file path", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ADriveRelativePathFailsTheStep()
    {
        // On Windows, "\orders.csv" is rooted (Path.IsPathRooted would accept it) but not fully
        // qualified: it still resolves against whatever drive is current, which is not a location any
        // workflow author chose. Production runs on Linux, where rooted and fully-qualified agree, so
        // this distinction is only visible here, on the platform the tests run on.
        var (processor, _) = Build();

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, """{"filePath":"\\orders.csv"}"""));

        Assert.Contains("did not name a file path", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheFailureMessageNamesTheClassOfFault()
    {
        // Step failures log at Information here, so the MESSAGE is what an operator searches — and
        // this step logs nothing of its own before throwing: ProcessDispatchHandler's catch for
        // FailedException already logs ex.Message verbatim at Information, so the exception's own
        // Message IS the record an operator's saved query matches on. This asserts that contract at
        // the level that actually carries it.
        var (processor, _) = Build();

        var ex = await Assert.ThrowsAsync<FailedException>(() => Run(processor, "not json"));

        Assert.StartsWith("input branch did not name a file path", ex.Message, StringComparison.Ordinal);
    }
}
