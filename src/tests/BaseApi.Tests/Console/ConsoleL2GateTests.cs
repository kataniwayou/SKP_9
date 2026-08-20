using BaseApi.Tests.Support;
using BaseConsole.Core.Gating;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Console;

public sealed class ConsoleL2GateTests
{
    private static (L2Gate Gate, RecordingLogger<L2Gate> Log) Build()
    {
        var log = new RecordingLogger<L2Gate>();
        return (new L2Gate(log), log);
    }

    [Fact]
    public async Task StartsClosedSoNothingConsumesBeforeTheStoreIsProvenReachable()
    {
        var (gate, _) = Build();

        Assert.False(gate.IsOpen);
        await Task.CompletedTask;
    }

    [Fact]
    public async Task OpensWhenTheProbeReportsHealthy()
    {
        var (gate, log) = Build();

        await gate.ReportHealthyAsync();

        Assert.True(gate.IsOpen);
        var record = Assert.Single(log.Records);
        Assert.Equal(LogLevel.Information, record.Level);
    }

    [Fact]
    public async Task ClosesWhenTripped()
    {
        var (gate, _) = Build();
        await gate.ReportHealthyAsync();

        await gate.TripAsync();

        Assert.False(gate.IsOpen);
    }

    [Fact]
    public async Task SignalsSubscribersOnEachTransition()
    {
        var (gate, _) = Build();
        var seen = new List<bool>();
        gate.StateChanged += open => seen.Add(open);

        await gate.ReportHealthyAsync();
        await gate.TripAsync();

        Assert.Equal([true, false], seen);
    }

    [Fact]
    public void ClassifiesTheThreeDeliveryOutcomes()
    {
        // The console copy must classify identically to the API copy, or a processor and the API would
        // disagree about whether a broker fault closes the gate.
        Assert.Equal(DeliveryDisposition.Park,
            DeliveryClassifier.Classify(new InvalidOperationException("message carries no type header")));

        Assert.Equal(DeliveryDisposition.RequeueAndTrip,
            DeliveryClassifier.Classify(new RedisTimeoutException("timed out", CommandStatus.WaitingInBacklog)));

        Assert.Equal(DeliveryDisposition.Requeue,
            DeliveryClassifier.Classify(new TransientSendException("send failed", new IOException("closed"))));
    }

    [Fact]
    public void PrefersTheSendClassificationWhenAStoreFaultIsNestedBeneathIt()
    {
        // The highest-risk drift this file exists to catch. L2FaultClassifier walks the whole inner
        // chain, so if the two branches of Classify were ever reordered in the console copy, a send
        // failure that happens to wrap a Redis type would close the gate over a store that never
        // failed — and every flat-exception assertion above would still pass.
        var ex = new TransientSendException("send to orchestrator-result failed",
            new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));

        Assert.Equal(DeliveryDisposition.Requeue, DeliveryClassifier.Classify(ex));
    }

    [Fact]
    public async Task DoesNotLogWhenTheStateIsUnchanged()
    {
        // The probe reports healthy on every healthy tick, so a per-call log would bury the transitions
        // this gate exists to surface. Pins the dedup guard inside SetAsync, which the transition tests
        // above cannot see.
        var (gate, log) = Build();
        await gate.ReportHealthyAsync();
        log.Records.Clear();

        await gate.ReportHealthyAsync();

        Assert.Empty(log.Records);
    }

    [Fact]
    public async Task DoesNotLogTrippingAGateThatStartedClosed()
    {
        var (gate, log) = Build();

        await gate.TripAsync();

        Assert.Empty(log.Records);
    }
}
