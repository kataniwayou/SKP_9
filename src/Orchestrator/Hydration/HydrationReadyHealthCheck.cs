using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace Orchestrator.Hydration;

/// <summary>
/// Readiness: has this replica finished mirroring L2 into L1 and admitted its consumer?
/// <para>
/// It reads <see cref="HydrationAdmission.IsOpen"/> and nothing else. That one latch is exactly the
/// condition, and it is the one field carrying synchronization — a health check runs on an arbitrary
/// thread, so anything else it read could be stale.
/// </para>
/// <para>
/// <b>Readiness, not startup, and emphatically not liveness.</b> This is the claim
/// <c>/health/startup</c> used to make, and it had to move: a startup probe has a finite budget, so
/// an L2 or broker outage — which <see cref="HydrationService"/> is built to retry through forever —
/// would eventually have the kubelet kill the pod for a fault no restart repairs. Liveness would do
/// the same, faster. Readiness is the one probe that may sit red for the length of an outage and go
/// green again without anything being restarted, which is precisely the shape of this condition. It
/// is the same reasoning that puts the processor's identity resolution on <c>ready</c>.
/// </para>
/// <para>
/// <b>Nothing routes traffic to these pods</b>, so failing readiness removes this replica from no
/// endpoint list and changes nothing about what it does. What it changes is the pod's <c>READY</c>
/// column, and that is the whole intent: <c>0/1</c> now reads as "still hydrating" rather than being
/// indistinguishable from a replica that is already consuming.
/// </para>
/// <para>
/// Both descriptions are static literals. A readiness body is served to anything that can route to
/// the pod, so no host, key or exception text belongs in one; why the pass has not finished is in the
/// logs.
/// </para>
/// </summary>
public sealed class HydrationReadyHealthCheck : IHealthCheck
{
    private readonly HydrationAdmission _admission;

    public HydrationReadyHealthCheck(HydrationAdmission admission)
        => _admission = admission ?? throw new ArgumentNullException(nameof(admission));

    public Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context, CancellationToken cancellationToken = default)
        => Task.FromResult(_admission.IsOpen
            ? HealthCheckResult.Healthy("L1 mirrors L2; consuming")
            : HealthCheckResult.Unhealthy("not yet hydrated from L2"));
}
