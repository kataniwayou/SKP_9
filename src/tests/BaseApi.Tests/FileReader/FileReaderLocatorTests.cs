using System.Text;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
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
        var processor = new FileReaderProcessor(log);
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
    public async Task TheFailureIsLoggedBeforeItIsThrown()
    {
        // Step failures log at Information here, so the MESSAGE is what an operator searches. A
        // thrown FailedException reaches the framework's log with a sanitized text; this line is
        // the one that names the class of fault.
        var (processor, log) = Build();

        await Assert.ThrowsAsync<FailedException>(() => Run(processor, "not json"));

        Assert.Contains(log.Records, r => r.Message.StartsWith(
            "input branch did not name a file path", StringComparison.Ordinal));
    }
}
