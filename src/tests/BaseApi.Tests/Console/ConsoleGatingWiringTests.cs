using BaseApi.Tests.Support;
using BaseConsole.Core.DependencyInjection;
using BaseConsole.Core.Gating;
using BaseConsole.Core.Loop;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace BaseApi.Tests.Console;

/// <summary>
/// The gate probe's heartbeat is, in its own words, the only evidence this process is still capable
/// of recovering from an outage. Evidence nobody reads is not evidence: without a liveness check over
/// it, a probe loop that stopped iterating leaves the gate shut, the consumer paused, the work queue
/// filling — and every health probe green.
/// </summary>
[Collection(EnvironmentCollection.Name)]
public sealed class ConsoleGatingWiringTests
{
    private static ServiceProvider Build(FakeTimeProvider? clock = null)
    {
        var services = new ServiceCollection();
        services.AddLogging();

        // Registered before the gating call so its TryAddSingleton(TimeProvider.System) stands down.
        services.AddSingleton<TimeProvider>(clock ?? new FakeTimeProvider());

        var cfg = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>()).Build();
        services.AddBaseConsoleGating(cfg, "some-work-queue");

        return services.BuildServiceProvider(validateScopes: true);
    }

    private static HealthCheckRegistration GateCheck(ServiceProvider sp) =>
        Assert.Single(
            sp.GetRequiredService<IOptions<HealthCheckServiceOptions>>().Value.Registrations,
            r => r.Name == "l2-gate");

    [Fact]
    public void RegistersALivenessCheckOverTheGateLoop()
    {
        using var sp = Build();

        var registration = GateCheck(sp);

        // Tagged live rather than ready: nothing inside the process can restart a loop that is gone,
        // so an external restart is the only repair, and the embedded endpoint selects by tag.
        Assert.Contains("live", registration.Tags);
        Assert.Equal(HealthStatus.Unhealthy, registration.FailureStatus);
        Assert.NotNull(registration.Factory(sp));
    }

    [Fact]
    public async Task TheCheckWatchesTheGateLoopsOwnHeartbeatAgainstTheStaleFactorBudget()
    {
        // Both halves matter. Reading the KEYED GateLoop holder is what makes the check specific to
        // the probe loop rather than to whichever heartbeat happened to resolve; deriving the window
        // from Interval x StaleFactor is what stops StaleFactor being a documented knob that nothing
        // reads.
        var clock = new FakeTimeProvider();
        using var sp = Build(clock);
        var options = sp.GetRequiredService<IOptions<L2GateOptions>>().Value;
        var check = GateCheck(sp).Factory(sp);
        var context = new HealthCheckContext { Registration = GateCheck(sp) };

        sp.GetRequiredKeyedService<ILoopHeartbeat>(ConsoleRedisServiceCollectionExtensions.GateLoop).Beat();

        // One tick short of the budget the options describe: still running.
        clock.Advance(options.Interval * options.StaleFactor - TimeSpan.FromTicks(1));
        var running = await check.CheckHealthAsync(context, TestContext.Current.CancellationToken);
        Assert.Equal(HealthStatus.Healthy, running.Status);

        // On the budget: stale, so the kubelet restarts the process rather than leaving the gate shut.
        clock.Advance(TimeSpan.FromTicks(1));
        var stale = await check.CheckHealthAsync(context, TestContext.Current.CancellationToken);
        Assert.Equal(HealthStatus.Unhealthy, stale.Status);
    }
}
