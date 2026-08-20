using BaseConsole.Core.Messaging;
using k8s;
using k8s.LeaderElection;
using k8s.LeaderElection.ResourceLock;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Orchestrator.Election;

/// <summary>
/// Spec §9. Contends for the <c>coordination.k8s.io/v1</c> Lease
/// <see cref="LeaseNamespace"/>/<see cref="LeaseName"/> for as long as the host runs, and translates
/// the outcome into <see cref="LeaderState"/> — of which it is the sole writer.
/// <para>
/// <b>Leadership decides only whether a replica dispatches, not what it knows.</b> All three replicas
/// keep a full L1 and a live schedule, and a follower's fires still run and still reschedule; they
/// simply stop short of the send. That is what makes a leadership change free — the new leader's
/// schedule is already running and already correct, so there is nothing to rebuild at the moment
/// there is least time to rebuild it.
/// </para>
/// <para>
/// <b><see cref="RenewDeadline"/> is below <see cref="LeaseDuration"/>, and inverting them breaks the
/// design.</b> That gap is the self-demotion fence: a leader whose renewal has not succeeded within
/// the deadline closes its own gate before the lease it holds can expire and be granted elsewhere.
/// Inverted, a demoted leader would keep dispatching until it happened to notice, alongside the
/// replica that had legitimately taken over — two leaders on one workflow, double-dispatching every
/// entry step.
/// </para>
/// <para>
/// <b>Registered only when the replica runs in-cluster</b>, which is what keeps this class out of
/// every hermetic test: no <c>IKubernetes</c> stub exists anywhere, because nothing hermetic ever
/// constructs one. Tests drive <see cref="LeaderState"/> directly, the same transitions the callbacks
/// below drive, and assert the timings against the constants. The live election is proven against a
/// cluster.
/// </para>
/// </summary>
public sealed class LeaderElectionService(
    LeaderState state,
    InstanceId instanceId,
    ILogger<LeaderElectionService> logger) : BackgroundService
{
    /// <summary>How long a granted lease stands without a renewal before another replica may take it.</summary>
    public static readonly TimeSpan LeaseDuration = TimeSpan.FromSeconds(15);

    /// <summary>
    /// How long the holder keeps trying to renew before demoting itself. Must stay below
    /// <see cref="LeaseDuration"/> — see the type remarks for what the gap is for.
    /// </summary>
    public static readonly TimeSpan RenewDeadline = TimeSpan.FromSeconds(10);

    /// <summary>How often a follower re-checks whether the lease has become acquirable.</summary>
    public static readonly TimeSpan RetryPeriod = TimeSpan.FromSeconds(2);

    /// <summary>The namespace holding the Lease. Fixed, so all three replicas contend for one object.</summary>
    public const string LeaseNamespace = "skp";

    /// <summary>The Lease's name. Fixed, for the same reason as <see cref="LeaseNamespace"/>.</summary>
    public const string LeaseName = "orchestrator-leader";

    /// <inheritdoc />
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // The same identity that names this replica's fan-out queue and its service.instance.id. It
        // has to be the same string: a lease holder an operator cannot trace back to a pod is a lease
        // holder they cannot do anything about, and under a StatefulSet it is a stable ordinal, so a
        // restarted replica contends under the name it contended under before.
        var identity = instanceId.Value;

        // In-cluster only, which is what makes the mounted ServiceAccount token — and therefore this
        // config — guaranteed present here rather than merely likely.
        using IKubernetes kubernetes = new Kubernetes(KubernetesClientConfiguration.InClusterConfig());

        var leaseLock = new LeaseLock(kubernetes, LeaseNamespace, LeaseName, identity);

        using var elector = new LeaderElector(new LeaderElectionConfig(leaseLock)
        {
            LeaseDuration = LeaseDuration,
            RenewDeadline = RenewDeadline,
            RetryPeriod   = RetryPeriod,
        });

        // The two callbacks below are the whole of the write side of LeaderState.
        elector.OnStartedLeading += () =>
        {
            state.BecomeLeader();
            logger.LogInformation("acquired the orchestrator lease as {Identity}; dispatching", identity);
        };

        elector.OnStoppedLeading += () =>
        {
            state.BecomeFollower();
            logger.LogInformation("lost the orchestrator lease as {Identity}; no longer dispatching", identity);
        };

        try
        {
            await elector.RunAndTryToHoldLeadershipForeverAsync(stoppingToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Shutdown. Nothing to clean up: the lease expires on its own and the next replica takes
            // it after at most LeaseDuration.
        }
    }
}
