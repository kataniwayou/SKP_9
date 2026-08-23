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
    public void ANestedAuthenticationFailureIsAConfigurationProblem()
    {
        // The client wraps this one, and the wrapper is BrokerUnreachableException — so a classifier
        // that read only the outermost type would report a wrong password as a dead host, which is
        // the answer that costs an operator the most time.
        var verdict = BrokerFaultClassifier.Classify(new BrokerUnreachableException(
            new AuthenticationFailureException("ACCESS_REFUSED - Login was refused")));

        Assert.Equal(DependencyFault.BlockedConfiguration, verdict.Fault);
        Assert.True(verdict.RestartRequired);
        Assert.Contains("RabbitMq:Password", verdict.SettingKey!, StringComparison.Ordinal);
    }

    [Fact]
    public void APossibleAuthenticationFailureIsTransient_BecauseABootingBrokerProducesIt()
    {
        // Named for authentication, but the client raises it whenever the handshake dies without the
        // broker saying why — which a broker that is still starting also does. Calling it a credential
        // fault would tell an operator to change a password that is fine.
        var verdict = BrokerFaultClassifier.Classify(
            new PossibleAuthenticationFailureException("handshake ended"));

        Assert.Equal(DependencyFault.Transient, verdict.Fault);
        Assert.False(verdict.RestartRequired);

        // It still points at the credentials as the thing to suspect if it persists, so the hint is
        // not lost — only the instruction.
        Assert.Contains("RabbitMq:Password", verdict.Reason, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData((ushort)403)]   // ACCESS_REFUSED — the account may not have this vhost
    [InlineData((ushort)530)]   // NOT_ALLOWED — the vhost is not available to this account
    public void ARefusedVirtualHostIsExternal_NotAConfigurationRestart(ushort replyCode)
    {
        // Deliberately external. A grant lands without a restart; a mistyped vhost is fixed in the
        // manifest, which redeploys anyway. Reported the other way round, a missing grant would earn
        // a restart that changes nothing and rotates away the log explaining the wait.
        var verdict = BrokerFaultClassifier.Classify(new OperationInterruptedException(
            new ShutdownEventArgs(ShutdownInitiator.Peer, replyCode, "ACCESS_REFUSED")));

        Assert.Equal(DependencyFault.BlockedExternal, verdict.Fault);
        Assert.False(verdict.RestartRequired);
        Assert.Contains("RabbitMq:VirtualHost", verdict.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void ATopologyMismatchIsExternal_AndSaysWaitingWillNotHelp()
    {
        // 406 PRECONDITION_FAILED: a queue already exists with different arguments. The classic
        // redeploy failure, and one no amount of backoff resolves.
        var verdict = BrokerFaultClassifier.Classify(new OperationInterruptedException(
            new ShutdownEventArgs(ShutdownInitiator.Peer, 406, "PRECONDITION_FAILED")));

        Assert.Equal(DependencyFault.BlockedExternal, verdict.Fault);
        Assert.Contains("different arguments", verdict.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void AShutdownWithAnUnrelatedReplyCodeIsNotTreatedAsARefusal()
    {
        // 320 CONNECTION_FORCED is an operator closing the connection, not a refusal to admit us.
        var verdict = BrokerFaultClassifier.Classify(new OperationInterruptedException(
            new ShutdownEventArgs(ShutdownInitiator.Peer, 320, "CONNECTION_FORCED")));

        Assert.Equal(DependencyFault.Transient, verdict.Fault);
    }

    [Fact]
    public void ASocketFailureIsTransient()
    {
        var verdict = BrokerFaultClassifier.Classify(
            new BrokerUnreachableException(new SocketException((int)SocketError.ConnectionRefused)));

        Assert.Equal(DependencyFault.Transient, verdict.Fault);
        Assert.Contains("RabbitMq:Host", verdict.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void AnAggregateIsFlattenedRatherThanFallingThroughToTheDefault()
    {
        // A connect that raced several endpoints surfaces as an aggregate. Walking only InnerException
        // would miss every branch but the first.
        var verdict = BrokerFaultClassifier.Classify(new AggregateException(
            new InvalidOperationException("unrelated"),
            new BrokerUnreachableException(new AuthenticationFailureException("refused"))));

        Assert.Equal(DependencyFault.BlockedConfiguration, verdict.Fault);
    }

    [Fact]
    public void AnUnrecognisedFailureResolvesTowardWaiting_NeverTowardARestart()
    {
        // The asymmetry that governs every ambiguous case: telling someone to wait through something
        // that needed a restart costs a minute; telling them to restart through something that was
        // recovering destroys the log and the backoff.
        var verdict = BrokerFaultClassifier.Classify(
            new InvalidOperationException("the queue was not declared"));

        Assert.Equal(DependencyFault.Transient, verdict.Fault);
        Assert.False(verdict.RestartRequired);
        Assert.Equal("the queue was not declared", verdict.Reason);
    }

    [Fact]
    public void OnlyAConfigurationVerdictTellsTheOperatorToRestart()
    {
        // The whole point of three states rather than two: "deterministic" is not the same question
        // as "do I touch this pod".
        var config = BrokerFaultClassifier.Classify(
            new BrokerUnreachableException(new AuthenticationFailureException("refused")));
        var external = BrokerFaultClassifier.Classify(new OperationInterruptedException(
            new ShutdownEventArgs(ShutdownInitiator.Peer, 403, "ACCESS_REFUSED")));

        Assert.Contains("restart this pod", config.Guidance, StringComparison.Ordinal);
        Assert.Contains("a restart will not either", external.Guidance, StringComparison.Ordinal);
    }

    [Fact]
    public void ANullExceptionIsARejectedArgumentRatherThanAClassification()
    {
        Assert.Throws<ArgumentNullException>(() => BrokerFaultClassifier.Classify(null!));
    }
}
