using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;

namespace BaseApi.Core.Gating;

/// <summary>
/// Reports whether the probe loop is still iterating. Nothing else.
/// <para>
/// <b>It deliberately does not look at the gate, the projection store, or the broker.</b> A closed
/// gate is this system working correctly — it means an outage was detected and consumption was
/// paused. Wiring that into liveness would restart the pod during exactly the outage the gate exists
/// to ride out, and on restart the gate would close again, producing a restart loop that lasts as
/// long as the dependency is down.
/// </para>
/// <para>
/// <b>What it catches is the class of failure that produces no exception.</b> An unhandled throw out
/// of a background service stops the host, and the process exiting is already visible. A loop that
/// hangs on an unbounded await, or that returns normally down some path nobody intended, does
/// neither: the host stays up, every other check stays green, and the process quietly stops being
/// able to recover from an outage. Since nothing inside the process can restart a loop that is gone —
/// a supervisor for the supervisor is the same problem one level up — only an external restart
/// resolves it, which is why this is reported as liveness rather than readiness.
/// </para>
/// </summary>
public sealed class LoopLivenessHealthCheck : IHealthCheck
{
    private readonly ILoopHeartbeat _heartbeat;
    private readonly L2GateOptions _options;
    private readonly TimeProvider _clock;

    public LoopLivenessHealthCheck(
        ILoopHeartbeat heartbeat, IOptions<L2GateOptions> options, TimeProvider clock)
    {
        _heartbeat = heartbeat ?? throw new ArgumentNullException(nameof(heartbeat));
        _options   = options?.Value ?? throw new ArgumentNullException(nameof(options));
        _clock     = clock ?? throw new ArgumentNullException(nameof(clock));
    }

    public Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        var last = _heartbeat.Last;
        if (last is null)
        {
            // Never beaten. Either the host is still starting, or the loop died before its first
            // iteration — indistinguishable from here, and the startup probe's grace period is what
            // separates them in practice.
            return Task.FromResult(HealthCheckResult.Unhealthy("probe loop has not started"));
        }

        var window = _options.Interval * _options.StaleFactor;
        var age = _clock.GetUtcNow() - last.Value;

        // Non-strict: the boundary instant counts as stale, so the threshold means what it reads as.
        return Task.FromResult(age >= window
            ? HealthCheckResult.Unhealthy("probe loop stale")
            : HealthCheckResult.Healthy("probe loop running"));
    }
}
