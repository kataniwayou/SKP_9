using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace BaseConsole.Core.Health;

/// <summary>
/// Reads <see cref="IStartupGate.IsReady"/> — the one-shot latch a worker flips once its own
/// initialisation is genuinely under way.
/// <para>
/// Tagged <c>startup</c> only. It is deliberately not tagged <c>live</c>: a startup probe that never
/// passes should stop traffic and eventually fail the pod's startup budget, not be reported as a
/// liveness failure, which restarts the process and loses whatever progress the latch was waiting on.
/// </para>
/// </summary>
public sealed class StartupHealthCheck(IStartupGate gate) : IHealthCheck
{
    public Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
        => Task.FromResult(gate.IsReady
            ? HealthCheckResult.Healthy("startup complete")
            : HealthCheckResult.Unhealthy("startup not complete"));
}
