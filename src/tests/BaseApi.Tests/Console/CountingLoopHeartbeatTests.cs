using BaseApi.Tests.Support;
using BaseConsole.Core.Loop;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace BaseApi.Tests.Console;

public sealed class CountingLoopHeartbeatTests
{
    /// <summary>
    /// Every measurement this test's own loop name produced. The instrument is static and
    /// process-wide, so a distinct loop name per test is what isolates one from another --
    /// the same reason L2GateMetricsTests asserts a delta rather than a set.
    /// </summary>
    private static List<double> ValuesFor(MetricCollector metrics, string loop) =>
        metrics.For(CountingLoopHeartbeat.IterationsInstrument)
            .Where(m => m.Tags["loop"] == loop)
            .Select(m => m.Value)
            .ToList();

    [Fact]
    public void TheCounterIsSeededSoALoopThatNeverRunsReadsZeroRatherThanAbsent()
    {
        using var metrics = new MetricCollector(CountingLoopHeartbeat.MeterName);

        _ = new CountingLoopHeartbeat(
            new LoopHeartbeat(TimeProvider.System), "test-never-runs");

        // A rate() threshold has nothing to compare against an absent series, so without
        // this seed the alert for "this loop never started" could not fire.
        Assert.Equal([0d], ValuesFor(metrics, "test-never-runs"));
    }

    [Fact]
    public void EachBeatCountsExactlyOnce()
    {
        using var metrics = new MetricCollector(CountingLoopHeartbeat.MeterName);

        var heartbeat = new CountingLoopHeartbeat(
            new LoopHeartbeat(TimeProvider.System), "test-counts-once");

        heartbeat.Beat();
        heartbeat.Beat();

        // The seed, then one per beat. Asserted as the full sequence rather than a sum, so
        // a double increment cannot hide behind a total that happens to look right.
        Assert.Equal([0d, 1d, 1d], ValuesFor(metrics, "test-counts-once"));
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
