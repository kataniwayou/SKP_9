using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using StackExchange.Redis;

namespace BaseApi.Core.Health;

/// <summary>
/// Redis readiness probe — a bounded health check that never throws. It lives in this assembly
/// rather than being shared with the worker host, because the API owns its own health pattern and
/// does not reference the console base library.
///
/// <para>
/// It is constructed with the outer <see cref="IServiceProvider"/> and resolves the singleton
/// multiplexer at check time rather than capturing it at registration. It is wrapped by
/// <see cref="ApiLatchedReadinessHealthCheck"/> in the readiness chain, so a sustained Redis failure
/// eventually latches.
/// </para>
///
/// <para>
/// <b>Contract:</b>
/// <list type="bullet">
///   <item>Multiplexer unresolved means unhealthy, so readiness never reports a stale healthy state.</item>
///   <item>A bounded ping that completes means healthy.</item>
///   <item>Any exception means unhealthy; the check never throws out of <see cref="CheckHealthAsync"/>.</item>
/// </list>
/// </para>
///
/// <para>
/// <b>Information-disclosure guard:</b> the result messages are static literals. The connection
/// string and the raw exception detail are never placed in the message or the data.
/// </para>
/// </summary>
public sealed class ApiRedisReadyHealthCheck : IHealthCheck
{
    private readonly IServiceProvider _outer;

    public ApiRedisReadyHealthCheck(IServiceProvider outer) => _outer = outer;

    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
    {
        // Resolve at check time, never captured at registration. An unresolved multiplexer means
        // unhealthy, so readiness cannot report healthy before Redis is up.
        //
        // Resolution is intentionally outside the ping budget: the singleton factory's first
        // synchronous connect can legitimately take longer than the ping window against a reachable
        // but cold Redis, and bounding it there turns a slow-but-successful connect into a false
        // not-ready — which then risks latching. The ping itself stays bounded below.
        var mux = _outer.GetService<IConnectionMultiplexer>();
        if (mux is null)
        {
            return Failure(context, "Redis not started");
        }

        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            cts.CancelAfter(TimeSpan.FromSeconds(2)); // bounded, so a dead Redis cannot hang the probe
            await mux.GetDatabase().PingAsync().WaitAsync(cts.Token).ConfigureAwait(false);
            return HealthCheckResult.Healthy();
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            // Static literal only — the connection string and raw exception detail never leak.
            return Failure(context, "Redis unreachable");
        }
    }

    /// <summary>
    /// Reports a failure at whatever severity the registration asked for, rather than hard-coding
    /// unhealthy.
    /// <para>
    /// <b>This has to be read from the registration or the cap is silently ignored.</b> A
    /// registration's failure status only applies to a check that <i>throws</i>; a check that returns
    /// a status returns exactly that status, so a check hard-coded to unhealthy cannot be capped from
    /// the outside. Registering it as degraded and returning unhealthy anyway would look correct at
    /// the registration and fail readiness regardless — the kind of mismatch that is only visible by
    /// reading the probe body.
    /// </para>
    /// </summary>
    private static HealthCheckResult Failure(HealthCheckContext context, string description)
        => new(context.Registration.FailureStatus, description);
}
