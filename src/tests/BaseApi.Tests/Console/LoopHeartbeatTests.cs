using BaseConsole.Core.Health;
using BaseConsole.Core.Loop;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace BaseApi.Tests.Console;

public sealed class LoopHeartbeatTests
{
    private static LoopLivenessHealthCheck Check(ILoopHeartbeat beat, TimeProvider clock) =>
        new(beat, Options.Create(new ConsoleLoopOptions
        {
            Interval = TimeSpan.FromSeconds(10),
            StaleFactor = 3,
        }), clock);

    [Fact]
    public void LastIsNullBeforeFirstBeat()
    {
        var clock = new FakeTimeProvider();
        Assert.Null(new LoopHeartbeat(clock).Last);
    }

    [Fact]
    public async Task UnhealthyBeforeFirstBeat()
    {
        var clock = new FakeTimeProvider();
        var result = await Check(new LoopHeartbeat(clock), clock)
            .CheckHealthAsync(new HealthCheckContext(), TestContext.Current.CancellationToken);

        Assert.Equal(HealthStatus.Unhealthy, result.Status);
    }

    [Fact]
    public async Task HealthyWithinTheStaleWindow()
    {
        var clock = new FakeTimeProvider();
        var beat = new LoopHeartbeat(clock);
        beat.Beat();
        clock.Advance(TimeSpan.FromSeconds(29));   // interval 10 * staleFactor 3 = 30

        var result = await Check(beat, clock)
            .CheckHealthAsync(new HealthCheckContext(), TestContext.Current.CancellationToken);

        Assert.Equal(HealthStatus.Healthy, result.Status);
    }

    [Fact]
    public async Task UnhealthyOnceTheStaleWindowElapses()
    {
        var clock = new FakeTimeProvider();
        var beat = new LoopHeartbeat(clock);
        beat.Beat();
        clock.Advance(TimeSpan.FromSeconds(31));

        var result = await Check(beat, clock)
            .CheckHealthAsync(new HealthCheckContext(), TestContext.Current.CancellationToken);

        Assert.Equal(HealthStatus.Unhealthy, result.Status);
    }
}
