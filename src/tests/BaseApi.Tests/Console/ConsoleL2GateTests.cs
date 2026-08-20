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
            DeliveryClassifier.Classify(new RedisTimeoutException("timed out", CommandStatus.Unknown)));

        Assert.Equal(DeliveryDisposition.Requeue,
            DeliveryClassifier.Classify(new TransientSendException("send failed", new IOException("closed"))));
    }
}
