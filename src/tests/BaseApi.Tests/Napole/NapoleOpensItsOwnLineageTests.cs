using System.Text.Json;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Transport;
using NSubstitute;
using Xunit;

namespace BaseApi.Tests.Napole;

public sealed class NapoleOpensItsOwnLineageTests
{
    private static async Task<ProcessedData> SendFor(Guid incomingExecutionId)
    {
        var sender = Substitute.For<IQueueSender>();
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var processor = NapoleProcessorTests.Processor(new FakeTrailSource(
            NapoleProcessorTests.Complete(), NapoleProcessorTests.Failed()));
        processor.BeginDispatch(TestDispatch.State(sender, Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid()));

        await processor.ExecuteAsync([], NapoleProcessorTests.Payload(), incomingExecutionId, TestContext.Current.CancellationToken);

        return Assert.Single(sends);
    }

    [Fact]
    public async Task AnEntryDispatchOpensANewLineage()
    {
        // The kafka-exporter refuses an empty id, so an entry step that forwarded Guid.Empty would
        // have every report thrown away one hop later.
        var sent = await SendFor(Guid.Empty);

        Assert.NotEqual(Guid.Empty, sent.ExecutionId);

        using var report = JsonDocument.Parse(sent.Data);
        var m = report.RootElement.GetProperty("mandatoryMeasurments");
        Assert.Equal(2, m.GetProperty("inputCount").GetInt32());
        Assert.Equal(1, m.GetProperty("outputCount").GetInt32());
        Assert.Equal(1, m.GetProperty("failedCount").GetInt32());
    }

    [Fact]
    public async Task ADispatchThatAlreadyHasALineageStaysInIt()
    {
        var existing = Guid.NewGuid();

        var sent = await SendFor(existing);

        Assert.Equal(existing, sent.ExecutionId);
    }
}
