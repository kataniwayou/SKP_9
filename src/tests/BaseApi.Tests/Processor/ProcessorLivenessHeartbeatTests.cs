using System.Text.Json;
using BaseApi.Tests.Support;
using BaseConsole.Core.Health;
using BaseConsole.Core.Loop;
using BaseConsole.Core.Messaging;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Liveness;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using NSubstitute;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class ProcessorLivenessHeartbeatTests
{
    private sealed class Harness
    {
        public IDatabase Db { get; } = Substitute.For<IDatabase>();
        public ProcessorContext Context { get; } = new();
        public LoopHeartbeat Beat { get; }
        public StartupGate Gate { get; } = new();
        public RecordingLogger<ProcessorLivenessHeartbeat> Log { get; } = new();
        public ProcessorLivenessHeartbeat Heartbeat { get; }

        public Harness()
        {
            var clock = new FakeTimeProvider();
            Beat = new LoopHeartbeat(clock);
            var redis = Substitute.For<IConnectionMultiplexer>();
            redis.GetDatabase().Returns(Db);
            var options = Options.Create(new ProcessorLivenessOptions());
            var writer = new ProcessorLivenessWriter(
                redis, new RecordingLogger<ProcessorLivenessWriter>());

            Heartbeat = new ProcessorLivenessHeartbeat(
                writer, Context, options, clock, Beat, Gate, new InstanceId("pod-1"), Log);
        }

        public void ResolveIdentityAndGoHealthy()
        {
            Context.SetIdentity(new ProcessorIdentityFound(
                Guid.NewGuid(), null, null, null, "sample", "1.0.0"));
            Context.MarkHealthy();
        }

        public ProcessorLivenessEntry? WrittenEntry()
        {
            var call = Db.ReceivedCalls()
                .FirstOrDefault(c => c.GetMethodInfo().Name == nameof(IDatabase.StringSetAsync));
            return call is null
                ? null
                : JsonSerializer.Deserialize<ProcessorLivenessEntry>(
                    call.GetArguments()[1]!.ToString()!);
        }
    }

    [Fact]
    public async Task BeatsEvenWhileUnhealthy()
    {
        // A replica booting against a down bus must still stamp liveness, or it is restarted during
        // exactly the outage it is waiting out.
        var h = new Harness();

        await h.Heartbeat.BeatOnceAsync();

        Assert.NotNull(h.Beat.Last);
    }

    [Fact]
    public async Task MarksTheStartupGateReadyOnTheFirstBeat()
    {
        var h = new Harness();

        await h.Heartbeat.BeatOnceAsync();

        Assert.True(h.Gate.IsReady);
    }

    [Fact]
    public async Task WritesNothingBeforeHealthy()
    {
        // The gate reader sees the replica as absent, which is correct — it is not servable yet.
        var h = new Harness();

        await h.Heartbeat.BeatOnceAsync();

        Assert.Null(h.WrittenEntry());
    }

    [Fact]
    public async Task WritesAHealthyEntryOnceHealthy()
    {
        var h = new Harness();
        h.ResolveIdentityAndGoHealthy();

        await h.Heartbeat.BeatOnceAsync();

        var entry = h.WrittenEntry();
        Assert.NotNull(entry);
        Assert.Equal(LivenessStatus.Healthy, entry!.Status);
        Assert.Equal(10, entry.Interval);   // the steady-state cadence, not the startup anchor
    }

    [Fact]
    public async Task RecordsReachingHealthyOnceRatherThanEveryBeat()
    {
        // Every beat writes the same value; only the edge is worth a line.
        var h = new Harness();
        h.ResolveIdentityAndGoHealthy();

        await h.Heartbeat.BeatOnceAsync();
        await h.Heartbeat.BeatOnceAsync();
        await h.Heartbeat.BeatOnceAsync();

        var healthyLines = h.Log.Records.Count(r =>
            r.Message.Contains("healthy", StringComparison.OrdinalIgnoreCase));
        Assert.Equal(1, healthyLines);
    }

    [Fact]
    public async Task NeverRetires()
    {
        // Unlike the startup loops, this one runs for process life — retiring it would stop anything
        // from noticing that L2 writes had ceased.
        var h = new Harness();

        await h.Heartbeat.BeatOnceAsync();

        Assert.False(h.Beat.IsRetired);
    }
}
