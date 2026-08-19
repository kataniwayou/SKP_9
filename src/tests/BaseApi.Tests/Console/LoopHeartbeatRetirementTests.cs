using BaseConsole.Core.Health;
using BaseConsole.Core.Loop;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace BaseApi.Tests.Console;

/// <summary>
/// A loop that finishes its job stops beating by design. Without a terminal state its check reports
/// stale one window later and kills a perfectly healthy process — so "completed" has to be
/// distinguishable from "wedged".
/// </summary>
public sealed class LoopHeartbeatRetirementTests
{
    private static readonly TimeSpan Window = TimeSpan.FromSeconds(30);

    private static LoopLivenessHealthCheck Check(ILoopHeartbeat beat, TimeProvider clock) =>
        new(beat, Window, "startup", clock);

    [Fact]
    public void NotRetiredBeforeRetireIsCalled()
    {
        Assert.False(new LoopHeartbeat(new FakeTimeProvider()).IsRetired);
    }

    [Fact]
    public void RetireIsIdempotent()
    {
        var beat = new LoopHeartbeat(new FakeTimeProvider());

        beat.Retire();
        beat.Retire();

        Assert.True(beat.IsRetired);
    }

    [Fact]
    public async Task HealthyLongAfterRetirement()
    {
        var clock = new FakeTimeProvider();
        var beat = new LoopHeartbeat(clock);
        beat.Beat();
        beat.Retire();
        clock.Advance(TimeSpan.FromHours(1));   // far past any window

        var result = await Check(beat, clock)
            .CheckHealthAsync(new HealthCheckContext(), TestContext.Current.CancellationToken);

        Assert.Equal(HealthStatus.Healthy, result.Status);
    }

    [Fact]
    public async Task RetirementIsCheckedBeforeStaleness()
    {
        // A loop can retire while already past its window — the ordering must not report it dead.
        var clock = new FakeTimeProvider();
        var beat = new LoopHeartbeat(clock);
        beat.Beat();
        clock.Advance(TimeSpan.FromMinutes(5));
        beat.Retire();

        var result = await Check(beat, clock)
            .CheckHealthAsync(new HealthCheckContext(), TestContext.Current.CancellationToken);

        Assert.Equal(HealthStatus.Healthy, result.Status);
    }

    [Fact]
    public async Task RetiringWithoutEverBeatingIsStillHealthy()
    {
        // A loop whose work was already done before its first tick is complete, not un-started.
        var clock = new FakeTimeProvider();
        var beat = new LoopHeartbeat(clock);
        beat.Retire();

        var result = await Check(beat, clock)
            .CheckHealthAsync(new HealthCheckContext(), TestContext.Current.CancellationToken);

        Assert.Equal(HealthStatus.Healthy, result.Status);
    }

    [Fact]
    public async Task TheLoopNameIsInTheDescriptionSoAFailureIdentifiesTheLoop()
    {
        var clock = new FakeTimeProvider();
        var beat = new LoopHeartbeat(clock);
        beat.Beat();
        clock.Advance(Window);

        var result = await Check(beat, clock)
            .CheckHealthAsync(new HealthCheckContext(), TestContext.Current.CancellationToken);

        Assert.Equal(HealthStatus.Unhealthy, result.Status);
        Assert.Contains("startup", result.Description ?? string.Empty, StringComparison.Ordinal);
    }
}
