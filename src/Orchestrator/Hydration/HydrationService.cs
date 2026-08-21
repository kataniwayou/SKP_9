using BaseConsole.Core.Health;
using BaseConsole.Core.Loop;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Orchestrator.L1;
using Orchestrator.Messaging;

namespace Orchestrator.Hydration;

/// <summary>
/// Loop 2: the pass that rebuilds this replica's L1 from L2 at start, and the thing that decides when
/// the replica may begin consuming at all.
/// <para>
/// <b>Why hydration comes before admission rather than after.</b> Until <see cref="HydrationAdmission"/>
/// opens, the durable fan-out queue accumulates announcements and nothing reads them. That ordering is
/// what makes a start announcement arriving mid-boot harmless: it waits, and by the time it is handled
/// the workflow it names is already in L1, so the handler converges on it instead of racing the pass
/// that was about to mirror it.
/// </para>
/// <para>
/// <b>Each pass declares this replica's topology before it reads a byte of L2, and the order is the
/// point.</b> Declaring is what creates the fan-out queue this replica listens on, and an
/// announcement published between the read and the declare would route to the replicas whose queues
/// already existed and be lost to this one for good — the pass would not see it in L2 either, having
/// already read. Doing it here rather than in a service ordered ahead of this one is what puts a
/// broker outage under the same backoff as an L2 outage, which is the contract this loop already
/// has; the alternative blocks host startup on a dependency that is allowed to be down.
/// </para>
/// <para>
/// <b>An unreachable L2 is not a reason to die.</b> Spec §6.4: the liveness check over this loop asks
/// one question — is the loop still ticking — and deliberately knows nothing about whether L2 answers
/// or whether the gate has opened. So a store fault beats the heartbeat, logs, backs off and tries
/// again forever. Restarting the pod would put a fresh process in front of the same dead store; the
/// only thing that would change is that the outage now reads as a crash loop.
/// </para>
/// <para>
/// <b>Which is why the startup gate is opened on the first beat and not on success.</b> The pod's
/// startup budget is finite, so a gate that waited for a complete pass would turn exactly that
/// survivable outage into the crash loop the paragraph above rules out — and under
/// <c>podManagementPolicy: Parallel</c> it would take all three replicas at once. Readiness here
/// claims what <c>ProcessorLivenessHeartbeat</c> claims on its own first beat: the loop is running.
/// Whether it has finished is <see cref="HydrationAdmission.IsOpen"/>, reported on
/// <c>/health/ready</c>, where a condition no restart can repair belongs.
/// </para>
/// <para>
/// <b>And a loop that simply stopped beating would be just as fatal.</b> A finished startup loop looks
/// exactly like a wedged one to a staleness window, so success ends with
/// <see cref="ILoopHeartbeat.Retire"/> — without it the pod would fail liveness one window after
/// hydrating perfectly well.
/// </para>
/// <para>
/// <b>The pass is strictly sequential over one workflow at a time.</b> <see cref="WorkflowActivator"/>
/// is check-then-act and not re-entrant — two concurrent activations of the same workflow can both
/// observe the same L1 entry, both tear its job down and both write, leaving a live Quartz job nothing
/// in L1 points at. Nothing here is fast enough to be worth that.
/// </para>
/// </summary>
public sealed class HydrationService : BackgroundService
{
    /// <summary>
    /// This loop's own identity: the key its heartbeat is registered under in <c>OrchestratorHost</c>,
    /// and the name its liveness health check is registered under there too. It lives here rather than
    /// on <c>OrchestratorHost</c> because it names this loop, not the composition root — a service
    /// reaching into the host to find its own key would be backwards. The <see cref="FromKeyedServicesAttribute"/>
    /// below and <c>OrchestratorHost.HydrationLoop</c> both point at this constant so the two cannot
    /// drift apart.
    /// </summary>
    internal const string LoopName = "orchestrator-hydration";

    /// <summary>
    /// Ceiling on the retry delay, which doubles from one second up to it. Thirty seconds is the same
    /// cap the processor's startup loops use, and for the same reason: it is short enough that a store
    /// coming back is noticed promptly and long enough that a long outage is not a busy wait.
    /// <para>
    /// <b>A constant rather than a bound options type, unlike the processor's.</b> The orchestrator has
    /// no configuration section and no <c>appsettings.json</c> of its own, so an options type here would
    /// carry one number nothing sets, while adding a section, a binding and a file. What the processor's
    /// <c>BackoffCapSeconds</c> earns by being configurable this would not.
    /// </para>
    /// </summary>
    internal static readonly TimeSpan BackoffCap = TimeSpan.FromSeconds(30);

    /// <summary>
    /// Multiples of the cap before a missing beat reads as dead. Three leaves room for one slow
    /// iteration without reporting a loop that is merely at the cap as gone.
    /// </summary>
    internal const int StaleFactor = 3;

    /// <summary>
    /// The staleness window this loop's liveness check is registered with. Derived here rather than at
    /// the registration site so the window and the delay it has to cover cannot drift apart: a window
    /// shorter than <see cref="BackoffCap"/> would restart the pod for waiting exactly as designed.
    /// </summary>
    internal static readonly TimeSpan LivenessWindow = BackoffCap * StaleFactor;

    private readonly ITopologyDeclarer _topology;
    private readonly L2WorkflowReader _reader;
    private readonly WorkflowActivator _activator;
    private readonly HydrationAdmission _admission;
    private readonly IStartupGate _startupGate;
    private readonly TimeProvider _clock;
    private readonly ILoopHeartbeat _heartbeat;
    private readonly ILogger<HydrationService> _logger;

    public HydrationService(
        ITopologyDeclarer topology,
        L2WorkflowReader reader,
        WorkflowActivator activator,
        HydrationAdmission admission,
        IStartupGate startupGate,
        TimeProvider clock,
        [FromKeyedServices(LoopName)] ILoopHeartbeat heartbeat,
        ILogger<HydrationService> logger)
    {
        _topology    = topology ?? throw new ArgumentNullException(nameof(topology));
        _reader      = reader ?? throw new ArgumentNullException(nameof(reader));
        _activator   = activator ?? throw new ArgumentNullException(nameof(activator));
        _admission   = admission ?? throw new ArgumentNullException(nameof(admission));
        _startupGate = startupGate ?? throw new ArgumentNullException(nameof(startupGate));
        _clock       = clock ?? throw new ArgumentNullException(nameof(clock));
        _heartbeat   = heartbeat ?? throw new ArgumentNullException(nameof(heartbeat));
        _logger      = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
        => RunUntilHydratedAsync(stoppingToken);

    /// <summary>
    /// Attempts the pass until one of them completes, backing off between failures. Returns once the
    /// replica is hydrated and admitted; throws <see cref="OperationCanceledException"/> on shutdown,
    /// which is the only other way out.
    /// </summary>
    internal async Task RunUntilHydratedAsync(CancellationToken ct)
    {
        var delay = TimeSpan.FromSeconds(1);

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            try
            {
                await RunOnceAsync(ct).ConfigureAwait(false);
                return;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // Named for the condition that actually holds: either dependency this pass touches
                // can fail it. The delay is the operator's only clue to how long the replica will sit
                // un-admitted; the exception carries which of the two it was.
                _logger.LogWarning(
                    ex, "hydration could not reach the broker or L2; retrying in {Delay}", delay);
            }

            await Task.Delay(delay, _clock, ct).ConfigureAwait(false);
            delay = TimeSpan.FromTicks(Math.Min(delay.Ticks * 2, BackoffCap.Ticks));
        }
    }

    /// <summary>
    /// One pass: beat, report the loop running, declare this replica's topology, read every workflow
    /// id L2 lists, activate each in turn, and — only if all of that finished — admit the consumer and
    /// retire the heartbeat.
    /// <para>
    /// <b>The startup gate is marked on the beat, not at the end.</b> It says this replica is starting
    /// correctly, which is true on every attempt including the ones that throw; the claim that L1 now
    /// mirrors L2 is <see cref="HydrationAdmission"/>'s, and the readiness probe reads that.
    /// </para>
    /// <para>
    /// Internal so a test can drive a single attempt without a host, the same seam
    /// <c>ProcessorStartupOrchestrator.RunStartupAsync</c> exposes.
    /// </para>
    /// <para>
    /// <b>The beat is per workflow as well as per pass.</b> A store holding thousands of workflows makes
    /// one pass itself longer than the staleness window, and a pod restarted mid-hydration for being
    /// slow would never get further than the same point on the next attempt.
    /// </para>
    /// </summary>
    internal async Task RunOnceAsync(CancellationToken ct)
    {
        _heartbeat.Beat();

        // Beside the beat, and for the same reason the processor's liveness loop marks itself ready on
        // its first beat: the loop is genuinely running, which is all readiness claims. Deliberately
        // not gated on the pass succeeding — a replica retrying an unreachable L2 or broker is
        // starting correctly, and a gate that waited for success would hold /health/startup red for
        // the whole outage until the kubelet spent the startup budget and killed the pod. Idempotent,
        // so calling it on every attempt costs a no-op rather than a first-attempt flag.
        _startupGate.MarkReady();

        // Before the first read of L2, and after the beat: a broker that is down must leave this loop
        // retrying and visibly alive, exactly as an L2 that is down does. A declare placed ahead of
        // the beat would leave the heartbeat unstamped for the whole outage and have the pod
        // restarted for waiting as designed.
        await _topology.EnsureDeclaredAsync(ct).ConfigureAwait(false);

        var workflowIds = await _reader.ReadAllIdsAsync(ct).ConfigureAwait(false);

        foreach (var workflowId in workflowIds)
        {
            ct.ThrowIfCancellationRequested();
            _heartbeat.Beat();

            await _activator.ActivateAsync(workflowId, ct).ConfigureAwait(false);
        }

        _logger.LogInformation(
            "hydrated {WorkflowCount} workflows from L2; admitting the consumer", workflowIds.Count);

        // Both of these follow a complete pass, and only these two. Admission first because it is what
        // changes this process's behaviour, retirement second because it is the statement that there
        // is nothing left of this loop to watch. Readiness is not here: it was claimed on the first
        // beat, above.
        _admission.Open();
        _heartbeat.Retire();
    }
}
