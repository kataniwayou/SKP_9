using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace BaseApi.Core.Messaging;

/// <summary>
/// Reports whether the broker connection is currently usable.
/// <para>
/// <b>Degraded rather than unhealthy, by registration.</b> The broker is a hard dependency for the
/// start and stop paths and no dependency at all for CRUD, so a broker outage must not take the pod
/// out of service and stop it answering the requests it can still answer. The cap is applied where
/// the check is registered, which is also where that judgement belongs.
/// </para>
/// <para>
/// It reports the same result before the first connection as during an outage. That is deliberate:
/// neither state can carry a send, and distinguishing them would only invite a reader to treat "not
/// yet connected" as success.
/// </para>
/// </summary>
public sealed class BrokerHealthCheck : IHealthCheck
{
    private readonly RabbitMqConnection _connection;

    public BrokerHealthCheck(RabbitMqConnection connection)
        => _connection = connection ?? throw new ArgumentNullException(nameof(connection));

    public Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context, CancellationToken cancellationToken = default)
        => Task.FromResult(_connection.IsOpen
            ? HealthCheckResult.Healthy("broker connected")
            // Static text: a connection fault's own message can carry host and credential detail, and
            // this string reaches the health endpoint's response body.
            : new HealthCheckResult(context.Registration.FailureStatus, "broker unavailable"));
}
