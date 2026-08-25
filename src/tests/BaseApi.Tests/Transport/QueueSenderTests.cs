using Messaging.Contracts;
using Messaging.Transport;
using RabbitMQ.Client;
using Xunit;

namespace BaseApi.Tests.Transport;

/// <summary>
/// The outgoing message properties, asserted directly.
/// <para>
/// <c>QueueSender.SendAsync</c> itself needs a live <see cref="RabbitMqConnection"/> — a sealed type
/// that builds a real <see cref="ConnectionFactory"/> — so the property construction is an internal
/// seam and this asserts on that. What matters here is which fields are set, not how they are
/// published.
/// </para>
/// </summary>
public sealed class QueueSenderTests
{
    [Fact]
    public void StampsTheCorrelationIdWhenTheCallerSuppliesOne()
    {
        // RpcQueueConsumer echoes this property onto every reply and logs it at four drop sites. Until
        // a sender wrote it, all of those rendered null and the id linked nothing to anything.
        var properties = QueueSender.BuildProperties(
            "get-processor", "proc-reply-pod-1", "abc123", new GetProcessorBySourceHash("hash"));

        Assert.Equal("abc123", properties.CorrelationId);
    }

    [Fact]
    public void LeavesTheCorrelationIdUnsetWhenTheCallerSuppliesNone()
    {
        // Fire-and-forget sends have nobody to pair with. An always-stamped id would put a value on
        // attributes.CorrelationId that no reply and no log line on the other side ever matches.
        var properties = QueueSender.BuildProperties("step-failed", null, null, new GetProcessorBySourceHash("hash"));

        Assert.Null(properties.CorrelationId);
        Assert.Null(properties.ReplyTo);
    }

    [Fact]
    public void StillCarriesTheDurabilityAndRoutingHeadersEveryMessageNeeds()
    {
        // Persistent alone does not survive a broker restart, and the type header is what the
        // consumer dispatches on — a correlation id must not have displaced either.
        var properties = QueueSender.BuildProperties(
            "get-processor", "proc-reply-pod-1", "abc123", new GetProcessorBySourceHash("hash"));

        Assert.Equal(DeliveryModes.Persistent, properties.DeliveryMode);
        Assert.Equal("application/json", properties.ContentType);
        Assert.Equal("get-processor", properties.Type);
        Assert.Equal("proc-reply-pod-1", properties.ReplyTo);
    }

    [Fact]
    public void StampsTheExecutionIdsAsHeadersSoAParkedMessageCanBeIdentified()
    {
        // The ids used to live only inside the serialized body, which is invisible to anything that
        // has not deserialized it -- the consumer's catch block above all, where a park is logged
        // after the handler's own scope has been disposed by the unwinding exception. Four outcomes
        // parked in one second produced four identical log lines against four distinct bodies.
        var outcome = new StepOutcome(
            Guid.Parse("11111111-1111-4111-8111-111111111111"),
            Guid.Parse("22222222-2222-4222-8222-222222222222"),
            Guid.Parse("33333333-3333-4333-8333-333333333333"),
            Guid.Parse("44444444-4444-4444-8444-444444444444"),
            Guid.Parse("55555555-5555-4555-8555-555555555555"),
            Guid.Parse("66666666-6666-4666-8666-666666666666"),
            StepResult.Completed);

        var headers = QueueSender.BuildProperties("step-outcome", null, null, outcome).Headers!;

        // "D" for the execution ids, so a value pastes into an L2 key lookup unchanged.
        Assert.Equal("22222222-2222-4222-8222-222222222222", headers[MessageIdHeaders.ExecutionId]);
        Assert.Equal("33333333-3333-4333-8333-333333333333", headers[MessageIdHeaders.WorkflowId]);
        Assert.Equal("44444444-4444-4444-8444-444444444444", headers[MessageIdHeaders.StepId]);
        Assert.Equal("55555555-5555-4555-8555-555555555555", headers[MessageIdHeaders.ProcessorId]);
        Assert.Equal("66666666-6666-4666-8666-666666666666", headers[MessageIdHeaders.EntryId]);

        // "N" for the correlation id, matching what CorrelationIdMiddleware echoes to clients. Two
        // spellings of one id on one Elasticsearch field is a join that silently matches nothing.
        Assert.Equal("11111111111141118111111111111111", headers[MessageIdHeaders.CorrelationId]);
    }

    [Fact]
    public void OmitsAnIdTheMessageDoesNotHaveRatherThanWritingZeros()
    {
        // An entry dispatch has no execution id and a source step no entry id. A header of all-zeros
        // would make "does not apply here" indistinguishable from "is the zero guid" to whoever reads
        // it off a parked message.
        var dispatch = new ProcessDispatch(
            Guid.Parse("11111111-1111-4111-8111-111111111111"),
            Guid.Empty,
            Guid.Parse("33333333-3333-4333-8333-333333333333"),
            Guid.Parse("44444444-4444-4444-8444-444444444444"),
            Guid.Parse("55555555-5555-4555-8555-555555555555"),
            "{}",
            Guid.Empty);

        var headers = QueueSender.BuildProperties("process-dispatch", null, null, dispatch).Headers!;

        Assert.False(headers.ContainsKey(MessageIdHeaders.ExecutionId));
        Assert.False(headers.ContainsKey(MessageIdHeaders.EntryId));
        Assert.True(headers.ContainsKey(MessageIdHeaders.WorkflowId));
    }

    [Fact]
    public void StampsNothingForAPayloadThatCarriesNoIds()
    {
        // The query queues have no dead-letter exchange and no execution identity; the sender has to
        // stay generic over every payload rather than growing a branch per contract.
        var headers = QueueSender
            .BuildProperties("get-processor", "proc-reply-pod-1", "abc123", new GetProcessorBySourceHash("h"))
            .Headers!;

        Assert.False(headers.ContainsKey(MessageIdHeaders.WorkflowId));
        Assert.False(headers.ContainsKey(MessageIdHeaders.CorrelationId));
    }
}
