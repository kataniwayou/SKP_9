using BaseProcessor.Core.Identity;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace BaseProcessor.Core.Health;

/// <summary>
/// Readiness: has this replica resolved its identity and every required schema definition?
/// <para>
/// It reads <see cref="IProcessorContext.IsHealthy"/> and nothing else. That single latch is exactly
/// the readiness condition, and it is the one field carrying synchronization — a health check runs on
/// an arbitrary thread, so anything else it read could be stale.
/// </para>
/// <para>
/// <b>Readiness, not liveness.</b> A processor still waiting for its database row is starting
/// correctly, however long that takes; restarting it would not help and would lose the backoff
/// progress. Liveness is the separate question of whether the loops are still turning.
/// </para>
/// <para>
/// Both descriptions are static literals — no processor id or infrastructure detail leaks into a
/// readiness body that anything on the network can request.
/// </para>
/// </summary>
public sealed class ProcessorIdentityReadyHealthCheck : IHealthCheck
{
    private readonly IProcessorContext _context;

    public ProcessorIdentityReadyHealthCheck(IProcessorContext context)
        => _context = context ?? throw new ArgumentNullException(nameof(context));

    public Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context, CancellationToken cancellationToken = default)
        => Task.FromResult(_context.IsHealthy
            ? HealthCheckResult.Healthy("identity and schemas resolved")
            : HealthCheckResult.Unhealthy("identity and schemas not yet resolved"));
}
