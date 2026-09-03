using System.Net.Sockets;
using BaseApi.Tests.Support;
using Messaging.Transport;
using RabbitMQ.Client.Exceptions;
using Xunit;

namespace BaseApi.Tests.Transport;

[Collection(EnvironmentCollection.Name)]
public sealed class EgressMetricsTests
{
    [Fact]
    public void ASendThatReturnedIsAccepted()
    {
        Assert.Equal("accepted", EgressMetrics.Classify(null));
    }

    [Fact]
    public void AnUnroutablePublishIsRoutingRatherThanTransport()
    {
        // The whole reason Classify tests routing before transport:
        // SendFaultClassifier.IsTransport returns TRUE for this type, so the opposite order
        // reports every undeclared queue as a broker blip -- and the two have opposite remedies.
        Assert.True(SendFaultClassifier.IsTransport(new UnroutablePublishException("x")));
        Assert.Equal("unroutable", EgressMetrics.Classify(new UnroutablePublishException("x")));
    }

    [Fact]
    public void ABrokerReturnIsRoutingRatherThanTransport()
    {
        // Same trap from the other direction: PublishException lives in the RabbitMQ.Client
        // namespace, which IsTransport matches wholesale by namespace prefix.
        var ex = new PublishException(publishSequenceNumber: 312, isReturn: true);

        Assert.True(SendFaultClassifier.IsTransport(ex));
        Assert.Equal("unroutable", EgressMetrics.Classify(ex));
    }

    [Fact]
    public void ASocketFailureIsTransient()
    {
        Assert.Equal("transient", EgressMetrics.Classify(new SocketException(10061)));
    }

    [Fact]
    public void AShutdownCancellationIsTransientRatherThanRefused()
    {
        // OperationCanceledException is on SendFaultClassifier's allow-list on purpose -- an
        // in-flight send during shutdown is the environment going away, not an unsendable message.
        Assert.Equal("transient", EgressMetrics.Classify(new OperationCanceledException()));
    }

    [Fact]
    public void ASerializationFaultIsRefused()
    {
        Assert.Equal("refused", EgressMetrics.Classify(new InvalidOperationException("bad")));
    }

    [Fact]
    public async Task ASuccessfulSendRecordsOneAcceptedMeasurementOnBothInstruments()
    {
        using var metrics = new MetricCollector(EgressMetrics.MeterName);

        await EgressMetrics.MeasureAsync(
            EgressMetrics.RouteQueue, "orchestrator-result", "step-outcome", () => Task.CompletedTask);

        var produced = Assert.Single(metrics.For("pipeline.messages.produced"));
        Assert.Equal(1, produced.Value);
        Assert.Equal("queue", produced.Tags["route"]);
        Assert.Equal("orchestrator-result", produced.Tags["destination"]);
        Assert.Equal("step-outcome", produced.Tags["type"]);
        Assert.Equal("accepted", produced.Tags["outcome"]);

        var duration = Assert.Single(metrics.For("pipeline.produce.duration"));
        Assert.Equal("accepted", duration.Tags["outcome"]);
        Assert.True(duration.Value >= 0);
    }

    [Fact]
    public async Task AFailedSendRecordsTheClassifiedOutcomeAndStillThrows()
    {
        using var metrics = new MetricCollector(EgressMetrics.MeterName);

        // The exception must reach the caller unchanged -- DeliveryClassifier and every catch
        // filter downstream turn on its type, so absorbing or wrapping it here would silently
        // repartition the requeue/park decision.
        await Assert.ThrowsAsync<SocketException>(() => EgressMetrics.MeasureAsync(
            EgressMetrics.RouteFanout, "orchestrator-fanout", "orchestration-started",
            () => throw new SocketException(10061)));

        var produced = Assert.Single(metrics.For("pipeline.messages.produced"));
        Assert.Equal("fanout", produced.Tags["route"]);
        Assert.Equal("transient", produced.Tags["outcome"]);

        Assert.Single(metrics.For("pipeline.produce.duration"));
    }
}
