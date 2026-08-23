using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// S8. One processor replica of two goes away while the other keeps working.
/// <para>
/// <b>Why this is not S6.</b> The processor scenario scales the deployment to zero, which every
/// aggregate on every board can see. This one takes away half the capacity: the two replicas share a
/// queue and the broker round-robins across it, so the survivor absorbs the departed replica's share
/// and total throughput barely moves. Nothing in an aggregate changes. `Replica fan-out` is the panel
/// that should show one series ending while the other carries on, and until this scenario existed it
/// had never been exercised by anything.
/// </para>
/// <para>
/// The obligation is unchanged and is the point: the survivor is entitled to every delivery the
/// departed replica did not take, so no step may be lost.
/// </para>
/// <para>
/// <b>Reuses <see cref="FaultKind.Processor"/> deliberately.</b> A graceful scale-down emits the same
/// shutdown and re-admission records whether one replica leaves or both do, and that kind already
/// carries the processor service filter the witness needs. A new kind would duplicate both.
/// </para>
/// </summary>
[Trait("Category", Chaos.Category)]
[Collection(Chaos.Category)]
public sealed class PartialReplicaLossScenarioTests
{
    [Fact]
    public async Task NoStepIsLostWhileOneOfTwoProcessorReplicasIsGone()
    {
        Chaos.SkipUnlessEnabled();

        var result = await OrchestrationSoak.RunAsync(
            new FaultSchedule(
                FaultKind.Processor,
                ct => ClusterControl.HoldScaledToAsync("deployment", "processor-sample", 1, 2, ct)),
            TestContext.Current.CancellationToken);

        OutageVerdict.AssertNoUnaccountedLoss(result);
    }
}
