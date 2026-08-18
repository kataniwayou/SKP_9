using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace BaseApi.Core.Health;

/// <summary>
/// Health check that reads <see cref="IStartupGate.IsReady"/>.
///
/// <para>
/// Tagged both <c>startup</c> and <c>ready</c>, so it appears in <c>/health/startup</c> and
/// <c>/health/ready</c>. The always-healthy <c>self</c> check is the only one tagged <c>live</c>:
/// liveness must never touch the database, or a database blip restarts every pod.
/// </para>
/// </summary>
public sealed class StartupHealthCheck(IStartupGate gate) : IHealthCheck
{
    public Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
        => Task.FromResult(gate.IsReady
            ? HealthCheckResult.Healthy("Startup complete")
            : HealthCheckResult.Unhealthy("Startup not complete (migrations pending)"));
}
