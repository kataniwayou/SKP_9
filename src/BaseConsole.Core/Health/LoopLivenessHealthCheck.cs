using BaseConsole.Core.Loop;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace BaseConsole.Core.Health;

/// <summary>
/// Reports whether one named loop is still iterating. Nothing else.
/// <para>
/// <b>It deliberately does not look at any gate, store or broker.</b> A paused consumer is this
/// system working correctly — it means an outage was detected. Wiring that into liveness would
/// restart the pod during exactly the outage the pause exists to ride out.
/// </para>
/// <para>
/// <b>The window is a constructor argument rather than an options type</b> because loops do not share
/// a cadence: a fixed-interval heartbeat and a loop backing off to a cap need windows derived from
/// different numbers, so binding one options type here would force them to agree.
/// </para>
/// </summary>
public sealed class LoopLivenessHealthCheck : IHealthCheck
{
    private readonly ILoopHeartbeat _heartbeat;
    private readonly TimeSpan _window;
    private readonly string _loop;
    private readonly TimeProvider _clock;

    /// <param name="window">How long without a beat before this loop reads as dead.</param>
    /// <param name="loop">Loop name, surfaced in the description so a failure says which loop died.</param>
    public LoopLivenessHealthCheck(
        ILoopHeartbeat heartbeat, TimeSpan window, string loop, TimeProvider clock)
    {
        _heartbeat = heartbeat ?? throw new ArgumentNullException(nameof(heartbeat));
        _window    = window;
        _loop      = loop ?? throw new ArgumentNullException(nameof(loop));
        _clock     = clock ?? throw new ArgumentNullException(nameof(clock));
    }

    public Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        // Retirement FIRST. A loop can finish while already past its window — checking staleness
        // before completion would report a finished loop as dead and restart a healthy process.
        if (_heartbeat.IsRetired)
        {
            return Task.FromResult(HealthCheckResult.Healthy($"{_loop} loop completed"));
        }

        if (_heartbeat.Last is not { } last)
        {
            return Task.FromResult(HealthCheckResult.Unhealthy($"{_loop} loop has not started"));
        }

        // Non-strict: the boundary instant counts as stale, so the threshold means what it reads as.
        return Task.FromResult(_clock.GetUtcNow() - last >= _window
            ? HealthCheckResult.Unhealthy($"{_loop} loop stale")
            : HealthCheckResult.Healthy($"{_loop} loop running"));
    }
}
