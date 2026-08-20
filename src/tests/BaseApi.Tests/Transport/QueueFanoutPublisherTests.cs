using Messaging.Transport;
using Xunit;

namespace BaseApi.Tests.Transport;

public sealed class QueueFanoutPublisherTests
{
    [Fact]
    public void ClassifiesAnUnroutablePublishAsTransport()
    {
        // Publisher confirms say the broker ACCEPTED the message, never that it ROUTED one. A fanout
        // exchange with no bound queue discards silently and still confirms, so the API would report a
        // start accepted and lose it. Reachable only before any replica has ever started — the queues
        // are durable thereafter — but that is exactly the first-deploy window.
        Assert.True(SendFaultClassifier.IsTransport(new UnroutablePublishException("orchestrator-fanout")));
    }

    [Fact]
    public void AnUnroutablePublishNamesTheExchangeAndNotTheBody()
    {
        // The exchange is a configuration fact and safe to log. The body is a workflow id today, but
        // this type is general, so it never quotes what it was carrying.
        var ex = new UnroutablePublishException("orchestrator-fanout");

        Assert.Contains("orchestrator-fanout", ex.Message, StringComparison.Ordinal);
    }
}
