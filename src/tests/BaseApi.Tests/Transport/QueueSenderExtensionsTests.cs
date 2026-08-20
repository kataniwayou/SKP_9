using Messaging.Transport;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using Xunit;

namespace BaseApi.Tests.Transport;

public sealed class QueueSenderExtensionsTests
{
    private sealed record Body(int Value);

    [Fact]
    public async Task WrapsASendFailureSoTheConsumerRequeuesInsteadOfParking()
    {
        var sender = Substitute.For<IQueueSender>();
        sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<Body>(),
                         Arg.Any<CancellationToken>(), Arg.Any<string?>())
              .ThrowsAsync(new IOException("socket closed"));

        var thrown = await Assert.ThrowsAsync<TransientSendException>(
            () => sender.SendTransientAsync("some-queue", "some-type", new Body(1), CancellationToken.None));

        Assert.IsType<IOException>(thrown.InnerException);
    }

    [Fact]
    public async Task NamesTheQueueSoTheFailureIsDiagnosableWithoutTheBody()
    {
        var sender = Substitute.For<IQueueSender>();
        sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<Body>(),
                         Arg.Any<CancellationToken>(), Arg.Any<string?>())
              .ThrowsAsync(new IOException("socket closed"));

        var thrown = await Assert.ThrowsAsync<TransientSendException>(
            () => sender.SendTransientAsync("orchestrator-result", "step-failed", new Body(1), CancellationToken.None));

        Assert.Contains("orchestrator-result", thrown.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DoesNotDoubleWrapAnAlreadyClassifiedFailure()
    {
        // A nested send that already classified itself must keep its original inner exception, or the
        // consumer's classifier sees a TransientSendException wrapping a TransientSendException and the
        // diagnosis loses the real cause.
        var sender = Substitute.For<IQueueSender>();
        var already = new TransientSendException("inner send failed", new IOException("socket closed"));
        sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<Body>(),
                         Arg.Any<CancellationToken>(), Arg.Any<string?>())
              .ThrowsAsync(already);

        var thrown = await Assert.ThrowsAsync<TransientSendException>(
            () => sender.SendTransientAsync("some-queue", "some-type", new Body(1), CancellationToken.None));

        Assert.Same(already, thrown);
    }

    [Fact]
    public async Task PassesThroughWhenTheSendSucceeds()
    {
        var sender = Substitute.For<IQueueSender>();

        await sender.SendTransientAsync("some-queue", "some-type", new Body(1), CancellationToken.None);

        await sender.Received(1).SendAsync("some-queue", "some-type", Arg.Any<Body>(),
                                           Arg.Any<CancellationToken>(), Arg.Any<string?>());
    }

    public static TheoryData<Exception> DeterministicFaults()
    {
        var data = new TheoryData<Exception>();
        data.Add((Exception)new System.Text.Json.JsonException("cycle detected"));
        data.Add((Exception)new NotSupportedException("no converter for this type"));
        data.Add((Exception)new ArgumentException("queue must not be blank"));
        data.Add((Exception)new InvalidOperationException("programming error"));
        return data;
    }

    [Theory]
    [MemberData(nameof(DeterministicFaults))]
    public async Task LeavesADeterministicFaultUnwrappedSoTheConsumerParksIt(Exception deterministic)
    {
        // IQueueSender.SendAsync serializes the body and validates its arguments inside the call, so
        // these reach us. Wrapping one would tell the consumer to requeue a message that fails
        // identically on every redelivery — an outage that never resolves.
        var sender = Substitute.For<IQueueSender>();
        sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<Body>(),
                         Arg.Any<CancellationToken>(), Arg.Any<string?>())
              .ThrowsAsync(deterministic);

        var thrown = await Assert.ThrowsAnyAsync<Exception>(
            () => sender.SendTransientAsync("some-queue", "some-type", new Body(1), CancellationToken.None));

        Assert.Same(deterministic, thrown);
        Assert.IsNotType<TransientSendException>(thrown);
    }

    public static TheoryData<Exception> TransportFaults()
    {
        var data = new TheoryData<Exception>();
        data.Add((Exception)new IOException("socket closed"));
        data.Add((Exception)new System.Net.Sockets.SocketException());
        data.Add((Exception)new TimeoutException("publish confirm timed out"));
        data.Add((Exception)new OperationCanceledException("shutting down"));
        data.Add((Exception)new InvalidOperationException("wrapped", new IOException("socket closed")));
        return data;
    }

    [Theory]
    [MemberData(nameof(TransportFaults))]
    public async Task WrapsATransportFaultSoTheConsumerRequeuesIt(Exception transport)
    {
        var sender = Substitute.For<IQueueSender>();
        sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<Body>(),
                         Arg.Any<CancellationToken>(), Arg.Any<string?>())
              .ThrowsAsync(transport);

        var thrown = await Assert.ThrowsAsync<TransientSendException>(
            () => sender.SendTransientAsync("some-queue", "some-type", new Body(1), CancellationToken.None));

        Assert.Same(transport, thrown.InnerException);
    }

    [Fact]
    public void FindsATransportFaultTheBrokerClientWrapped()
    {
        // Broker libraries wrap: a socket failure commonly arrives inside a higher-level exception, and
        // reading only the outermost type would classify it as unsendable and park recoverable work.
        var wrapped = new InvalidOperationException("outer",
            new InvalidOperationException("middle", new IOException("socket closed")));

        Assert.True(SendFaultClassifier.IsTransport(wrapped));
    }

    [Fact]
    public void ClassifiesADisposedChannelAsTransport()
    {
        // A channel disposed underneath a send during shutdown throws this, and it is neither in the
        // allow-list's original set nor in the broker client's namespace. The send site must not have
        // to rescue it with a catch-all: parking a message because the process was shutting down is
        // a park nothing can retry, and the classification decision belongs here.
        Assert.True(SendFaultClassifier.IsTransport(new ObjectDisposedException("IChannel")));
    }

    [Fact]
    public void FindsADisposedChannelTheBrokerClientWrapped()
    {
        Assert.True(SendFaultClassifier.IsTransport(
            new InvalidOperationException("outer", new ObjectDisposedException("IChannel"))));
    }

    [Fact]
    public void FindsATransportFaultHidingPastTheFirstBranchOfAnAggregate()
    {
        // AggregateException.InnerException is only the FIRST inner one, so walking the chain reaches
        // exactly one branch and a socket failure in position 2 is classified deterministic and
        // parked. The sibling classifier on the projection side (L2FaultClassifier.Unwrap) flattens
        // for this reason; this one must too.
        var aggregate = new AggregateException(
            new NotSupportedException("no converter for this type"),
            new System.Net.Sockets.SocketException());

        Assert.True(SendFaultClassifier.IsTransport(aggregate));
    }

    [Fact]
    public void StillSeesNoTransportFaultInAnAggregateOfDeterministicOnes()
    {
        // The flattening must not turn "walked more exceptions" into "found one".
        var aggregate = new AggregateException(
            new NotSupportedException("no converter"),
            new ArgumentException("queue must not be blank"));

        Assert.False(SendFaultClassifier.IsTransport(aggregate));
    }

    [Fact]
    public void DoesNotSeeATransportFaultWhereThereIsNone()
    {
        Assert.False(SendFaultClassifier.IsTransport(
            new InvalidOperationException("outer", new NotSupportedException("inner"))));
    }
}
