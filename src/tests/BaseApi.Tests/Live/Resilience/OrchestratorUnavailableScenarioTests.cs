using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// S7. The orchestrator statefulset is scaled to zero for a minute mid-orchestration.
/// <para>
/// <b>This does not breach the "never scale down" invariant.</b> That rule forbids reducing the
/// orchestrator's replica count because each replica owns a durable per-replica queue that would
/// accumulate forever once its owner was gone. Scaling 3 to 0 and back to 3 restores the same
/// ordinals, and therefore the same queue names, so no queue is orphaned. Restoring to a smaller
/// count would breach it; this does not.
/// </para>
/// <para>
/// <b>A fire that never happened is not a lost step.</b> With no scheduler running the cron does not
/// fire at all for the duration, so a sixty-second outage costs roughly two fires outright. Those
/// runs do not exist to be judged — the ledger only reasons about runs that started — so the floor
/// drops to seven. Asserting nine here would fail on the scenario working exactly as intended.
/// </para>
/// <para>
/// In-flight step-outcome messages accumulate in the durable per-replica queues meanwhile. On return
/// all three replicas rebuild L1 from L2, re-arm the cron, re-settle the Lease that fences the
/// leader, and drain their queues.
/// </para>
/// </summary>
[Trait("Category", Chaos.Category)]
public sealed class OrchestratorUnavailableScenarioTests
{
    /// <summary>
    /// Seven rather than nine: see the class remarks. This is the one scenario whose fault removes
    /// fires rather than delaying the work they cause.
    /// </summary>
    private const int MinimumRunsWithFiresSuppressed = 7;

    [Fact]
    public async Task NoStepIsLostWhileTheOrchestratorIsGone()
    {
        Chaos.SkipUnlessEnabled();

        var result = await OrchestrationSoak.RunAsync(
            new FaultSchedule(
                FaultKind.Orchestrator,
                ct => ClusterControl.HoldScaledDownAsync("statefulset", "orchestrator", 3, ct)),
            TestContext.Current.CancellationToken);

        OutageVerdict.AssertNoUnaccountedLoss(result, MinimumRunsWithFiresSuppressed);
    }
}
