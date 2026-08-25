using BaseConsole.Core.Loop;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Orchestrator.L1;

/// <summary>
/// Loop 3: drops the workflows a stop marked, once they have been stopped long enough that nothing can
/// still be in flight for them.
/// <para>
/// <b>What it is collecting.</b> A stop unschedules the workflow's job and marks its L1 entry rather
/// than removing it, so a step still running when the stop landed can come back, resolve against the
/// definition, and let its run drain. Without this loop those marked entries would accumulate for the
/// life of the process — a slow leak in a dictionary nothing else prunes, one entry per workflow ever
/// stopped.
/// </para>
/// <para>
/// <b>The grace period is a full round trip, and that is the number to change if a run can outlive
/// it.</b> An entry reaped while one of its steps is still on the wire puts that outcome back in the
/// parked state this whole design exists to avoid. Erring long costs one stale dictionary entry;
/// erring short costs a dead-lettered message and an operator to recover it by hand.
/// </para>
/// <para>
/// <b>Runs on every replica, not just the leader.</b> L1 is per-replica in-memory state — each replica
/// marked its own entries and each has to prune its own. Gating this on leadership would leave every
/// follower's marks permanent.
/// </para>
/// <para>
/// <b>Nothing here depends on this loop having run.</b> A pass that never happens leaves stopped
/// workflows resolvable for longer than intended, which is the safe direction; it cannot resurrect
/// one, because the schedule was torn down at the stop and <see cref="WorkflowL1Store.TryGetActive"/>
/// hides marked entries from every path that could start new work.
/// </para>
/// </summary>
public sealed class L1ReapService : BackgroundService
{
    /// <summary>
    /// This loop's own identity: the key its heartbeat is registered under in <c>OrchestratorHost</c>,
    /// and the name its liveness health check is registered under there too. It lives here rather than
    /// on <c>OrchestratorHost</c> because it names this loop, not the composition root — the
    /// <see cref="FromKeyedServicesAttribute"/> below and <c>OrchestratorHost.ReapLoop</c> both point at
    /// this constant so the two cannot drift apart.
    /// </summary>
    internal const string LoopName = "orchestrator-l1-reap";

    /// <summary>
    /// How long a workflow stays resolvable after being stopped. One hour, on the assumption that no
    /// run's full round trip outlasts it — see the type remarks for which way to err.
    /// </summary>
    internal static readonly TimeSpan GracePeriod = TimeSpan.FromHours(1);

    /// <summary>
    /// How often the pass runs. Deliberately much shorter than <see cref="GracePeriod"/>: a tick equal
    /// to the grace period would let an entry live anywhere from one to two hours depending on where
    /// its stop fell between ticks, where this pins the real lifetime to the grace period plus at most
    /// one tick. The pass is a scan of an in-memory dictionary, so the shorter tick costs nothing.
    /// </summary>
    internal static readonly TimeSpan Period = TimeSpan.FromMinutes(5);

    /// <summary>
    /// Multiples of the period before a missing beat reads as dead. Three leaves room for one slow
    /// iteration without reporting a loop that is merely between ticks as gone.
    /// </summary>
    internal const int StaleFactor = 3;

    /// <summary>
    /// The staleness window this loop's liveness check is registered with. Derived here rather than at
    /// the registration site so the window and the cadence it has to cover cannot drift apart: a window
    /// shorter than <see cref="Period"/> would restart the pod for waiting exactly as designed.
    /// </summary>
    internal static readonly TimeSpan LivenessWindow = Period * StaleFactor;

    private readonly WorkflowL1Store _store;
    private readonly TimeProvider _clock;
    private readonly ILoopHeartbeat _heartbeat;
    private readonly ILogger<L1ReapService> _logger;

    public L1ReapService(
        WorkflowL1Store store,
        TimeProvider clock,
        [FromKeyedServices(LoopName)] ILoopHeartbeat heartbeat,
        ILogger<L1ReapService> logger)
    {
        _store     = store ?? throw new ArgumentNullException(nameof(store));
        _clock     = clock ?? throw new ArgumentNullException(nameof(clock));
        _heartbeat = heartbeat ?? throw new ArgumentNullException(nameof(heartbeat));
        _logger    = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>
    /// Beat, reap, wait — forever, until the host stops.
    /// <para>
    /// <b>The beat is the first statement of the body, and it is unconditional.</b> Two things follow
    /// from that. It stamps on the first iteration at process start, which closes the window in which
    /// the heartbeat has never been written — <c>LoopLivenessHealthCheck</c> reads an unstamped
    /// heartbeat as <i>unhealthy</i>, and the orchestrator's probe tolerates roughly two minutes of
    /// that, so a loop that waited a five-minute period before its first beat would crash-loop the pod
    /// on every start. And it stamps even on an iteration whose pass throws, which is correct: this
    /// heartbeat answers whether the loop is turning and nothing else. A beat placed after the pass, or
    /// inside the try, would restart the pod for a work-correctness problem no restart can fix — the
    /// same reason the health check deliberately reads no gate, store or broker.
    /// </para>
    /// <para>
    /// <b>And it never retires.</b> Retirement means a loop has finished and is permanently healthy;
    /// this one runs for the life of the process, so retiring it would blind its check for good.
    /// </para>
    /// </summary>
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Period);

        while (true)
        {
            _heartbeat.Beat();

            try
            {
                Reap();
            }
            catch (Exception ex)
            {
                // The pass is a scan of an in-memory dictionary with no I/O in it, so there is little
                // here to fail — but a swallowed fault on a loop that keeps beating is invisible, and
                // this line is the only thing that would say so.
                _logger.LogWarning(ex, "an L1 reap pass failed; retrying next period");
            }

            try
            {
                await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // The only way out. Caught rather than allowed to escape ExecuteAsync, where the
                // default BackgroundService behaviour is to stop the host — during shutdown that is
                // harmless and during anything else it would be a surprise.
                return;
            }
        }
    }

    /// <summary>
    /// One pass. Internal so a test can drive it without a timer or a host — the same seam
    /// <c>HydrationService.RunOnceAsync</c> exposes, and the reason the loop above needs no fake clock
    /// to be tested.
    /// </summary>
    internal void Reap()
    {
        var reaped = _store.ReapDeletedBefore(_clock.GetUtcNow() - GracePeriod);

        // Silent when there is nothing to do, which is almost every pass — a line per tick saying
        // "reaped 0" would be 288 records a day per replica burying the ones that mean something.
        if (reaped.Count == 0)
        {
            return;
        }

        // Information, and naming the ids. This is the only record that a stopped workflow stopped
        // being resolvable, so an outcome parked just after one of these lines is explained by it —
        // and without the ids that pairing needs a guess.
        _logger.LogInformation(
            "reaped {ReapedCount} workflow(s) stopped more than {GracePeriod} ago: {WorkflowIds}",
            reaped.Count, GracePeriod, string.Join(", ", reaped));
    }
}
