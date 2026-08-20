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
        var properties = QueueSender.BuildProperties("get-processor", "proc-reply-pod-1", "abc123");

        Assert.Equal("abc123", properties.CorrelationId);
    }

    [Fact]
    public void LeavesTheCorrelationIdUnsetWhenTheCallerSuppliesNone()
    {
        // Fire-and-forget sends have nobody to pair with. An always-stamped id would put a value on
        // attributes.CorrelationId that no reply and no log line on the other side ever matches.
        var properties = QueueSender.BuildProperties("step-failed", null, null);

        Assert.Null(properties.CorrelationId);
        Assert.Null(properties.ReplyTo);
    }

    [Fact]
    public void StillCarriesTheDurabilityAndRoutingHeadersEveryMessageNeeds()
    {
        // Persistent alone does not survive a broker restart, and the type header is what the
        // consumer dispatches on — a correlation id must not have displaced either.
        var properties = QueueSender.BuildProperties("get-processor", "proc-reply-pod-1", "abc123");

        Assert.Equal(DeliveryModes.Persistent, properties.DeliveryMode);
        Assert.Equal("application/json", properties.ContentType);
        Assert.Equal("get-processor", properties.Type);
        Assert.Equal("proc-reply-pod-1", properties.ReplyTo);
    }
}
