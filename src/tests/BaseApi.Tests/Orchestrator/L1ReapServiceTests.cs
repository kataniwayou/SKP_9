using BaseConsole.Core.Health;
using BaseConsole.Core.Loop;
using Messaging.Contracts;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Orchestrator.L1;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// Loop 3: the pass that collects the L1 entries a stop marked, once nothing can still be in flight
/// for them.
/// <para>
/// <b>The pass is driven directly rather than through the timer.</b> <c>Reap</c> is internal for the
/// same reason <c>HydrationService.RunOnceAsync</c> is — the loop around it is three statements whose
/// only interesting property is the order of the first two, and driving a <see cref="PeriodicTimer"/>
/// through a fake clock to assert a dictionary got smaller would test the BCL rather than this code.
/// </para>
/// </summary>
public sealed class L1ReapServiceTests
{
    private static readonly Guid W = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid V = Guid.Parse("44444444-4444-4444-4444-444444444444");

    private static readonly DateTimeOffset Now =
        new(2026, 8, 25, 12, 0, 0, TimeSpan.Zero);

    private sealed class Harness
    {
        public WorkflowL1Store Store { get; } = new();

        public FakeTimeProvider Clock { get; } = new(Now);

        public LoopHeartbeat Heartbeat { get; }

        public Harness() => Heartbeat = new LoopHeartbeat(Clock);

        public Harness Holding(Guid workflowId, TimeSpan? stoppedAgo = null)
        {
            Store.Set(workflowId, new WorkflowL1(workflowId, [], null, []), Guid.NewGuid());

            if (stoppedAgo is { } ago)
            {
                Store.MarkDeleted(workflowId, Now - ago);
            }

            return this;
        }

        public L1ReapService Build() => new(
            Store, Clock, Heartbeat, NullLogger<L1ReapService>.Instance);
    }

    [Fact]
    public void APassDropsAWorkflowStoppedLongerThanTheGracePeriod()
    {
        var h = new Harness().Holding(W, stoppedAgo: L1ReapService.GracePeriod + TimeSpan.FromMinutes(1));

        h.Build().Reap();

        Assert.False(h.Store.TryGetIncludingStopped(W, out _));
    }

    [Fact]
    public void APassLeavesAWorkflowStoppedInsideTheGracePeriodResolvable()
    {
        // The whole reason the grace period exists. Reaping early puts an outcome for a step still in
        // flight back in the parked state this design was built to remove — so the boundary matters
        // in one direction much more than the other.
        var h = new Harness().Holding(W, stoppedAgo: L1ReapService.GracePeriod - TimeSpan.FromMinutes(1));

        h.Build().Reap();

        Assert.True(h.Store.TryGetIncludingStopped(W, out _));
    }

    [Fact]
    public void APassNeverDropsARunningWorkflow()
    {
        // The guard against the reaper becoming a way to delete live workflows. A running entry has no
        // stamp to compare against a cutoff, and must survive every pass no matter how long it has
        // been there.
        var h = new Harness().Holding(W).Holding(V, stoppedAgo: TimeSpan.FromDays(7));

        h.Build().Reap();

        Assert.True(h.Store.TryGetActive(W, out _));
        Assert.False(h.Store.TryGetIncludingStopped(V, out _));
    }

    [Fact]
    public async Task TheLoopBeatsBeforeItHasDoneAnyWork()
    {
        // The crash-loop guard, and the reason the beat is the first statement of the loop body rather
        // than the last. LoopLivenessHealthCheck reads a never-stamped heartbeat as UNHEALTHY, and the
        // orchestrator's probe tolerates roughly two minutes of that (initialDelay 30s, period 15s,
        // failureThreshold 6) against a five-minute tick — so a loop that waited one period before its
        // first beat would have the kubelet kill the pod on every single start, forever.
        var h = new Harness();
        Assert.Null(h.Heartbeat.Last);

        using var cts = new CancellationTokenSource();
        var service = h.Build();
        await service.StartAsync(cts.Token);

        // No clock advance and no tick: whatever is asserted here was true before the first period
        // could possibly have elapsed.
        Assert.Equal(Now, h.Heartbeat.Last);

        await service.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task TheLoopNeverRetiresItsHeartbeat()
    {
        // Retirement means a loop has finished and is permanently healthy, which is true of hydration
        // and false of this one — it runs for the life of the process. Retiring it would report a
        // wedged reaper as healthy for good, which is precisely the condition the check exists for.
        var h = new Harness();

        using var cts = new CancellationTokenSource();
        var service = h.Build();
        await service.StartAsync(cts.Token);
        await service.StopAsync(CancellationToken.None);

        Assert.False(h.Heartbeat.IsRetired);
    }

    [Fact]
    public async Task AStaleHeartbeatIsWhatTheLivenessCheckReports()
    {
        // The other half of the contract: the loop stamps, the probe judges. Asserted through the real
        // check with the real window rather than by arithmetic on the constants, so a window that
        // stopped covering its own period would fail here rather than in production.
        var h = new Harness();
        var check = new LoopLivenessHealthCheck(
            h.Heartbeat, L1ReapService.LivenessWindow, "l1-reap", h.Clock);
        var context = new HealthCheckContext();

        using var cts = new CancellationTokenSource();
        var service = h.Build();
        await service.StartAsync(cts.Token);

        h.Clock.Advance(L1ReapService.Period);
        Assert.Equal(HealthStatus.Healthy, (await check.CheckHealthAsync(context, TestContext.Current.CancellationToken)).Status);

        h.Clock.Advance(L1ReapService.LivenessWindow);
        Assert.Equal(HealthStatus.Unhealthy, (await check.CheckHealthAsync(context, TestContext.Current.CancellationToken)).Status);

        await service.StopAsync(CancellationToken.None);
    }

    [Fact]
    public void TheGracePeriodIsLongerThanTheTickThatCollectsIt()
    {
        // A tick equal to the grace period would let an entry live anywhere between one and two grace
        // periods depending on where its stop fell between ticks. Stated as a test because the two
        // numbers are independently editable constants and nothing else would catch them crossing.
        Assert.True(
            L1ReapService.Period < L1ReapService.GracePeriod,
            "the reap tick must be shorter than the grace period it collects against");

        // And the window has to outlast the period, or the pod is restarted for waiting exactly as
        // designed — the same relationship HydrationService derives its own window from.
        Assert.True(
            L1ReapService.LivenessWindow > L1ReapService.Period,
            "the staleness window must be longer than the tick it watches");
    }
}
