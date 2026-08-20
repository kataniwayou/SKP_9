using System.Text.Json;
using Messaging.Contracts;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class ExecutionContractsTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");

    [Fact]
    public void ADispatchSurvivesARoundTripThroughTheSharedSerializer()
    {
        var sent = new ProcessDispatch(W, S, P)
        {
            CorrelationId = Guid.Parse("44444444-4444-4444-4444-444444444444"),
            ExecutionId = Guid.Empty,
            EntryId = Guid.Parse("55555555-5555-5555-5555-555555555555"),
            Payload = """{"Number":5}""",
        };

        var bytes = JsonSerializer.SerializeToUtf8Bytes(sent, MessagingJson.Options);
        var back = JsonSerializer.Deserialize<ProcessDispatch>(bytes, MessagingJson.Options);

        Assert.Equal(sent, back);
    }

    [Fact]
    public void ProcessedDataCarriesItsBytesUnchanged()
    {
        // Data is the ground truth the post handler writes to L2. A round trip that alters a byte
        // would corrupt every downstream step with nothing to show for it.
        var payload = new byte[] { 0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d };
        var sent = new ProcessedData(W, S, P) { MessageId = Guid.NewGuid(), Data = payload };

        var bytes = JsonSerializer.SerializeToUtf8Bytes(sent, MessagingJson.Options);
        var back = JsonSerializer.Deserialize<ProcessedData>(bytes, MessagingJson.Options);

        Assert.Equal(payload, back!.Data);
    }

    [Fact]
    public void QueueNamesAreDerivedFromTheProcessorId()
    {
        Assert.Equal("processor-33333333-3333-3333-3333-333333333333", ProcessorQueues.Work(P));
        Assert.Equal("processor-33333333-3333-3333-3333-333333333333.dead", ProcessorQueues.Dead(P));
    }

    [Fact]
    public void EveryWireTypeIsDistinct()
    {
        string[] types =
        [
            MessageTypes.ProcessDispatch, MessageTypes.ProcessedData,
            MessageTypes.StepCompleted, MessageTypes.StepFailed, MessageTypes.StepCancelled,
        ];

        Assert.Equal(types.Length, types.Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public void TheLogScopeCarriesEveryPopulatedId()
    {
        var state = ExecutionLogScope.BuildState(W, S, P, Guid.Parse("66666666-6666-6666-6666-666666666666"),
                                                 Guid.Parse("77777777-7777-7777-7777-777777777777"));

        Assert.Equal(5, state.Count);
        Assert.Equal("11111111-1111-1111-1111-111111111111", state[ExecutionLogScope.WorkflowId]);
    }

    [Fact]
    public void AnEmptyIdIsOmittedRatherThanRenderedAsZeros()
    {
        // An entry dispatch has no ExecutionId and a source step has no EntryId. Emitting all-zeros
        // would make "absent" and "the zero guid" indistinguishable to anything querying these logs.
        var state = ExecutionLogScope.BuildState(W, S, P, Guid.Empty, Guid.Empty);

        Assert.False(state.ContainsKey(ExecutionLogScope.ExecutionId));
        Assert.False(state.ContainsKey(ExecutionLogScope.EntryId));
        Assert.Equal(3, state.Count);
    }

    [Fact]
    public void TheCorrelationIdRendersTheWayTheHttpMiddlewareRendersIt()
    {
        // The middleware mints Guid.NewGuid().ToString("N") and echoes it in X-Correlation-Id. A bus
        // side rendering the default "D" would put two spellings of one id on one Elasticsearch field,
        // and a query joining an HTTP request to its bus work would silently return nothing.
        var id = Guid.Parse("44444444-4444-4444-4444-444444444444");

        Assert.Equal("44444444444444444444444444444444", CorrelationKeys.Render(id));
        Assert.Equal("CorrelationId", CorrelationKeys.LogScope);
    }
}
