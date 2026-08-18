using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace BaseApi.Core.Health;

/// <summary>
/// Readiness latch decorator: a thin health check wrapping a required-dependency check. It counts
/// consecutive unhealthy evaluations and, once the count reaches the threshold, flips a per-process
/// sticky latch that returns unhealthy until the process restarts — even if the inner check later
/// recovers. A single non-unhealthy result before the threshold resets the counter, so a transient
/// blip does not latch.
///
/// <para>
/// It keys off consecutive failed evaluations, riding the kubelet's own polling cadence. The latch
/// instance must be per-process — registered as a singleton — so its state persists across probe
/// polls; constructing one per check defeats the whole mechanism. Wrap the required dependencies
/// with it, but not the soft publish-only bus check, which stays unlatched.
/// </para>
/// </summary>
public sealed class ApiLatchedReadinessHealthCheck : IHealthCheck
{
    private const string LatchedMessage =
        "readiness latched (sustained dependency failure — restart required)";

    // Static pre-latch message: the inner check's description and exception are never forwarded, not
    // even on the failing polls before the latch trips. The wrapped Postgres check is a third-party
    // one that attaches the raw driver exception, carrying host, port, database and auth detail, so
    // returning a static literal on every unhealthy path keeps the guard intact whatever is wrapped.
    private const string UnhealthyMessage =
        "readiness dependency unhealthy";

    private readonly IHealthCheck _inner;
    private readonly int _failureThreshold;

    // Single-prober assumption: the interlocked operations prevent torn reads but are not a
    // transactional read-modify-write across the whole check. That is exact under the standard model
    // where probes are sequential. With multiple concurrent probers, a healthy reset could interleave
    // with a failing increment and transiently erase progress toward the latch.
    private int _consecutiveFailures;
    private volatile bool _latched;

    public ApiLatchedReadinessHealthCheck(IHealthCheck inner, int failureThreshold)
    {
        _inner = inner;
        _failureThreshold = failureThreshold;
    }

    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
    {
        // Once latched, stay unhealthy — recovery is by restart only, never self-healing.
        if (_latched)
        {
            return HealthCheckResult.Unhealthy(LatchedMessage);
        }

        var result = await _inner.CheckHealthAsync(context, cancellationToken).ConfigureAwait(false);

        if (result.Status == HealthStatus.Unhealthy)
        {
            // Count consecutive failures; latch once the threshold is reached.
            if (Interlocked.Increment(ref _consecutiveFailures) >= _failureThreshold)
            {
                _latched = true;
                return HealthCheckResult.Unhealthy(LatchedMessage);
            }

            // Never forward the inner result verbatim — see the note on the pre-latch message.
            return HealthCheckResult.Unhealthy(UnhealthyMessage);
        }

        // Any non-unhealthy result resets the counter, so a transient blip does not latch.
        Interlocked.Exchange(ref _consecutiveFailures, 0);
        return result;
    }
}
