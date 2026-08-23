using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace BaseApi.Core.Health;

/// <summary>
/// Health check that reads <see cref="IStartupGate.IsReady"/>: has the startup loop begun?
///
/// <para>
/// <b>Tagged <c>startup</c> only.</b> It used to be tagged <c>ready</c> as well, back when the gate
/// meant "migrations have been applied" — but the gate now means "the migration loop is running",
/// which is true on every attempt including the failing ones. That is deliberately a weak claim: a
/// startup probe has a finite budget, and a dependency outage that outlasts it gets the container
/// killed. Whether the schema is actually in place is <see cref="MigrationReadyHealthCheck"/>'s
/// claim, on <c>/health/ready</c>, which has no budget to exhaust.
/// </para>
/// <para>
/// The always-healthy <c>self</c> check is the only one tagged <c>live</c>: liveness must never touch
/// the database, or a database blip restarts every pod.
/// </para>
/// </summary>
public sealed class StartupHealthCheck(IStartupGate gate) : IHealthCheck
{
    public Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
        => Task.FromResult(gate.IsReady
            ? HealthCheckResult.Healthy("Startup loop running")
            : HealthCheckResult.Unhealthy("Startup loop has not begun"));
}
