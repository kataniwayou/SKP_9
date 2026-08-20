using BaseApi.Core.Messaging;
using Messaging.Transport;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Messaging;

public sealed class DeliveryClassifierTests
{
    [Fact]
    public void ParksAFailureThatSaysTheMessageIsWrong()
    {
        var ex = new InvalidOperationException("no handler is registered for this message type");

        Assert.Equal(DeliveryDisposition.Park, DeliveryClassifier.Classify(ex));
    }

    [Fact]
    public void RequeuesAndTripsWhenTheProjectionStoreIsUnreachable()
    {
        var ex = new RedisTimeoutException("timed out", CommandStatus.WaitingInBacklog);

        Assert.Equal(DeliveryDisposition.RequeueAndTrip, DeliveryClassifier.Classify(ex));
    }

    [Fact]
    public void RequeuesWithoutTrippingWhenOnlyTheBrokerFailed()
    {
        // The projection store said nothing about itself here. Tripping the gate would pause
        // consumption of a store that is healthy, spreading one dependency's outage to another.
        var ex = new TransientSendException("send to orchestrator-result failed",
                                            new IOException("socket closed"));

        Assert.Equal(DeliveryDisposition.Requeue, DeliveryClassifier.Classify(ex));
    }

    [Fact]
    public void PrefersTheSendClassificationWhenAStoreFaultIsNestedBeneathIt()
    {
        // A send failure whose chain happens to contain a Redis type must not trip the gate: the
        // outermost classification is the one that names what actually failed. L2FaultClassifier
        // walks the whole chain, so without an explicit ordering it would win.
        var ex = new TransientSendException("send to orchestrator-result failed",
                                            new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));

        Assert.Equal(DeliveryDisposition.Requeue, DeliveryClassifier.Classify(ex));
    }

    [Fact]
    public void FindsAStoreFaultWrappedByAHandler()
    {
        // L2FaultClassifier already walks the chain; this pins that the classifier does not lose it.
        var ex = new InvalidOperationException("projecting the workflow failed",
                                               new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));

        Assert.Equal(DeliveryDisposition.RequeueAndTrip, DeliveryClassifier.Classify(ex));
    }
}
