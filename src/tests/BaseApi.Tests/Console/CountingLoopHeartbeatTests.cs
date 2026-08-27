using BaseApi.Tests.Support;
using BaseConsole.Core.Loop;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace BaseApi.Tests.Console;

public sealed class CountingLoopHeartbeatTests
{
    /// <summary>
    /// Every measurement this test's own loop name produced, one per poll. The instrument is
    /// static and process-wide, so a distinct loop name per test is what isolates one from another
    /// -- the same reason L2GateMetricsTests asserts a delta rather than a set.
    /// <para>
    /// <b>Polled, not pushed.</b> The iteration count is an observable, so it publishes only when
    /// asked and each reading is the running total rather than an increment. That shape is what
    /// makes the seed work at all: a pushed seed reaches only readers that already exist, and every
    /// seed in this stack is taken from a constructor, before any MeterProvider is built. See
    /// LoopMetrics.
    /// </para>
    /// </summary>
    private static List<double> ValuesFor(MetricCollector metrics, string loop) =>
        metrics.For(CountingLoopHeartbeat.IterationsInstrument)
            .Where(m => m.Tags["loop"] == loop)
            .Select(m => m.Value)
            .ToList();

    [Fact]
    public void TheCounterIsSeededSoALoopThatNeverRunsReadsZeroRatherThanAbsent()
    {
        _ = new CountingLoopHeartbeat(
            new LoopHeartbeat(TimeProvider.System), "test-never-runs");

        // The collector is built AFTER the seed on purpose. That ordering is production's --
        // hosted-service constructors all run before the OpenTelemetry hosted service builds the
        // provider -- and it is the ordering that silently dropped this seed while it was a pushed
        // Add(0). A rate() threshold has nothing to compare against an absent series, so the alert
        // for "this loop never started" could not fire.
        using var metrics = new MetricCollector(CountingLoopHeartbeat.MeterName);
        metrics.Collect();

        Assert.Equal([0d], ValuesFor(metrics, "test-never-runs"));
    }

    [Fact]
    public void EachBeatCountsExactlyOnce()
    {
        using var metrics = new MetricCollector(CountingLoopHeartbeat.MeterName);

        var heartbeat = new CountingLoopHeartbeat(
            new LoopHeartbeat(TimeProvider.System), "test-counts-once");

        // Polled between beats, so the sequence is one reading per beat rather than one
        // measurement per beat. Asserted as the full sequence rather than a final total, so a
        // double increment cannot hide behind a sum that happens to look right.
        metrics.Collect();
        heartbeat.Beat();
        metrics.Collect();
        heartbeat.Beat();
        metrics.Collect();

        Assert.Equal([0d, 1d, 2d], ValuesFor(metrics, "test-counts-once"));
    }

    [Fact]
    public void TheStampAndTheRetirementReachTheInnerHolder()
    {
        var clock = new FakeTimeProvider();
        var inner = new LoopHeartbeat(clock);
        var heartbeat = new CountingLoopHeartbeat(inner, "test-delegates");

        Assert.Null(heartbeat.Last);

        heartbeat.Beat();
        Assert.Equal(clock.GetUtcNow(), heartbeat.Last);

        Assert.False(heartbeat.IsRetired);
        heartbeat.Retire();

        // Both faces, because a liveness check may hold either reference.
        Assert.True(heartbeat.IsRetired);
        Assert.True(inner.IsRetired);
    }
}
