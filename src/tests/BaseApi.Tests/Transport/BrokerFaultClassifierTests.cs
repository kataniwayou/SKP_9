using System.Net.Sockets;
using Messaging.Transport;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;
using RabbitMQ.Client.Exceptions;
using Xunit;

namespace BaseApi.Tests.Transport;

public sealed class BrokerFaultClassifierTests
{
    [Fact]
    public void ANestedAuthenticationFailureIsCredentials()
    {
        // The client wraps this one, and the wrapper is BrokerUnreachableException — so a classifier
        // that read only the outermost type would report a wrong password as a dead host, which is
        // the answer that costs an operator the most time.
        var ex = new BrokerUnreachableException(
            new AuthenticationFailureException("ACCESS_REFUSED - Login was refused"));

        Assert.Equal(BrokerFaultClassifier.Fault.Credentials, BrokerFaultClassifier.Classify(ex));
    }

    [Fact]
    public void APossibleAuthenticationFailureIsAlsoCredentials()
    {
        // The client raises this variant when the connection dies during the handshake without the
        // broker having said why. It is still the credential path, and lumping it under Other would
        // send the operator looking at the network.
        var ex = new PossibleAuthenticationFailureException("handshake ended");

        Assert.Equal(BrokerFaultClassifier.Fault.Credentials, BrokerFaultClassifier.Classify(ex));
    }

    [Theory]
    [InlineData((ushort)403)]   // ACCESS_REFUSED — the account may not have this vhost
    [InlineData((ushort)530)]   // NOT_ALLOWED — the vhost does not exist for this account
    public void ARefusedVirtualHostIsAuthorisation(ushort replyCode)
    {
        // These arrive as a connection shutdown rather than a typed exception, so the reply code is
        // the only thing that identifies them.
        var ex = new OperationInterruptedException(
            new ShutdownEventArgs(ShutdownInitiator.Peer, replyCode, "ACCESS_REFUSED"));

        Assert.Equal(BrokerFaultClassifier.Fault.Authorisation, BrokerFaultClassifier.Classify(ex));
    }

    [Fact]
    public void AShutdownWithAnUnrelatedReplyCodeIsNotAuthorisation()
    {
        // 320 CONNECTION_FORCED is an operator closing the connection, not a refusal to admit us.
        var ex = new OperationInterruptedException(
            new ShutdownEventArgs(ShutdownInitiator.Peer, 320, "CONNECTION_FORCED"));

        Assert.NotEqual(BrokerFaultClassifier.Fault.Authorisation, BrokerFaultClassifier.Classify(ex));
    }

    [Fact]
    public void ASocketFailureIsUnreachable()
    {
        var ex = new BrokerUnreachableException(
            new SocketException((int)SocketError.ConnectionRefused));

        Assert.Equal(BrokerFaultClassifier.Fault.Unreachable, BrokerFaultClassifier.Classify(ex));
    }

    [Fact]
    public void AnAggregateIsFlattenedRatherThanFallingThroughToOther()
    {
        // A connect that raced several endpoints surfaces as an aggregate. Walking only InnerException
        // would miss every branch but the first.
        var ex = new AggregateException(
            new InvalidOperationException("unrelated"),
            new BrokerUnreachableException(new AuthenticationFailureException("refused")));

        Assert.Equal(BrokerFaultClassifier.Fault.Credentials, BrokerFaultClassifier.Classify(ex));
    }

    [Fact]
    public void SomethingUnrecognisedIsOtherAndDescribesItself()
    {
        var ex = new InvalidOperationException("the queue was not declared");

        Assert.Equal(BrokerFaultClassifier.Fault.Other, BrokerFaultClassifier.Classify(ex));
        Assert.Equal("the queue was not declared", BrokerFaultClassifier.Describe(ex));
    }

    [Fact]
    public void EveryDescriptionNamesTheConfigurationKeyThatFixesIt()
    {
        // The point of the classifier is that the log line itself is actionable. A description that
        // named the failure without naming the knob would leave the operator exactly where they were.
        Assert.Contains(
            "RabbitMq:Password",
            BrokerFaultClassifier.Describe(
                new BrokerUnreachableException(new AuthenticationFailureException("refused"))),
            StringComparison.Ordinal);

        Assert.Contains(
            "RabbitMq:VirtualHost",
            BrokerFaultClassifier.Describe(new OperationInterruptedException(
                new ShutdownEventArgs(ShutdownInitiator.Peer, 403, "ACCESS_REFUSED"))),
            StringComparison.Ordinal);

        Assert.Contains(
            "RabbitMq:Host",
            BrokerFaultClassifier.Describe(
                new BrokerUnreachableException(new SocketException((int)SocketError.HostNotFound))),
            StringComparison.Ordinal);
    }

    [Fact]
    public void ANullExceptionIsARejectedArgumentRatherThanAClassification()
    {
        Assert.Throws<ArgumentNullException>(() => BrokerFaultClassifier.Classify(null!));
    }
}
