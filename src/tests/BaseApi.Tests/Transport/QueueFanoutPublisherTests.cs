using Messaging.Transport;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace BaseApi.Tests.Transport;

public sealed class QueueFanoutPublisherTests
{
    [Fact]
    public async Task ClassifiesAnAlreadyCancelledPublishAsTransport()
    {
        // The gate wait sits before any channel work, so a caller that arrives already cancelled must
        // still see TransientSendException — DeliveryClassifier requires the OUTERMOST type to be
        // TransientSendException to requeue, and a raw OperationCanceledException would park the
        // control message instead. RabbitMqConnection only opens a real connection lazily on its first
        // GetAsync call, which an already-cancelled gate wait never reaches, so no broker is needed.
        var publisher = new QueueFanoutPublisher(
            new RabbitMqConnection(
                Options.Create(new RabbitMqOptions()),
                Array.Empty<IRabbitMqTopology>(),
                NullLogger<RabbitMqConnection>.Instance),
            NullLogger<QueueFanoutPublisher>.Instance);

        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAsync<TransientSendException>(
            () => publisher.PublishAsync("orchestrator-fanout", "workflow-created", new object(), cts.Token));
    }

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
