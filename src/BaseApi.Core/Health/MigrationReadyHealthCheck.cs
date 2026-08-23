using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace BaseApi.Core.Health;

/// <summary>
/// Readiness: is the schema in place? Until it is, this pod cannot serve a request that touches the
/// database, and nothing should be routed to it.
/// <para>
/// <b>This is the probe that carries a migration failure, and <c>/health/startup</c> is not.</b> A
/// startup probe has a finite budget — thirty attempts at five seconds in the manifest — and a
/// dependency outage lasting longer than that used to end with the kubelet killing the container,
/// destroying the very log that explained the wait. Readiness has no such budget: it may sit red for
/// the length of an outage and recover without a restart, which is exactly the shape of this failure.
/// </para>
/// <para>
/// <b>The body says what to do, not what went wrong.</b> It carries the verdict's fault kind, its
/// guidance and — when there is one — the configuration key at fault. It never carries the reason
/// string or the driver's exception: those quote server messages and connection detail, and this body
/// is readable by anything that can reach the port. Naming <c>ConnectionStrings:Postgres</c> is
/// actionable; quoting what Postgres said about it is a disclosure.
/// </para>
/// </summary>
public sealed class MigrationReadyHealthCheck(IMigrationState state) : IHealthCheck
{
    private readonly IMigrationState _state = state ?? throw new ArgumentNullException(nameof(state));

    public Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        if (_state.Applied)
        {
            return Task.FromResult(HealthCheckResult.Healthy("schema applied"));
        }

        var verdict = _state.LastFailure;

        if (verdict is null)
        {
            // Before the first attempt completes. Distinct from a failure so an operator reading the
            // body during a normal start is not shown a fault that has not happened.
            return Task.FromResult(new HealthCheckResult(
                context.Registration.FailureStatus, "schema not applied yet — the migration loop is running"));
        }

        var key = verdict.SettingKey is null ? string.Empty : $" ({verdict.SettingKey})";

        return Task.FromResult(new HealthCheckResult(
            context.Registration.FailureStatus,
            $"schema not applied — {verdict.Fault}{key}: {verdict.Guidance}"));
    }
}
