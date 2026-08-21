using Microsoft.Extensions.Diagnostics.HealthChecks;
using Orchestrator.Hydration;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// The replacement for what <c>/health/startup</c> used to report. Startup readiness now means the
/// hydration loop is running, so "this replica has mirrored L2" needs somewhere else to be visible or
/// it is a silent regression — an operator staring at three green pods would have no way to tell a
/// replica that is consuming from one that is still retrying.
/// <para>
/// <b>Readiness rather than liveness or startup</b>, for the same reason the processor puts identity
/// resolution there: no restart repairs an L2 that is down, and readiness is the one probe that may
/// fail freely and recover without killing the process.
/// </para>
/// </summary>
public sealed class HydrationReadyHealthCheckTests
{
    private static Task<HealthCheckResult> CheckAsync(HydrationAdmission admission)
        => new HydrationReadyHealthCheck(admission)
            .CheckHealthAsync(new HealthCheckContext(), TestContext.Current.CancellationToken);

    [Fact]
    public async Task IsUnhealthyUntilHydrationHasAdmittedTheConsumer()
    {
        var result = await CheckAsync(new HydrationAdmission());

        Assert.Equal(HealthStatus.Unhealthy, result.Status);
    }

    [Fact]
    public async Task IsHealthyOnceHydrationHasAdmittedTheConsumer()
    {
        var admission = new HydrationAdmission();
        admission.Open();

        var result = await CheckAsync(admission);

        Assert.Equal(HealthStatus.Healthy, result.Status);
    }
}
