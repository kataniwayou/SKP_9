using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// S9. One processor replica of two stays alive and reporting while it stops consuming.
/// <para>
/// <b>The fault class the suite never had.</b> Every other scenario removes something entirely —
/// Redis paused, the broker scaled away, a replica scaled away. All of them are *absence*, which is
/// the easiest thing a board can show. This one produces a replica that is **present**: its process
/// runs, its HTTP server answers, its metrics keep arriving — and its consumer is disconnected from
/// the broker. Nothing in an aggregate moves, no worker count changes, and the replica passes every
/// liveness window on every board.
/// </para>
/// <para>
/// <b>Why it is not S8.</b> Partial replica loss removes a replica; this one keeps it. Those look
/// the same in any panel that cannot resolve a single replica, and different in exactly one:
/// `Consuming by queue and replica` should draw the wedged replica's line **at zero, beside a peer
/// still at one**, where a departure would end the line instead. That distinction is what the panel
/// was split per replica to make, and until this scenario existed nothing exercised it.
/// </para>
/// <para>
/// <b>Reuses <see cref="FaultKind.Rabbit"/> deliberately.</b> A disconnected consumer logs the same
/// arrival and heal records as a broker outage — the channel shuts down, then the connection
/// recovers and consumption is re-admitted — because from the replica's point of view that is what
/// happened. A new kind would duplicate both template sets to say the same thing, which is the
/// reasoning <see cref="PartialReplicaLossScenarioTests"/> already applies to
/// <see cref="FaultKind.Processor"/>.
/// </para>
/// <para>
/// <b>The obligation is the standing one.</b> The healthy peer is entitled to every delivery the
/// wedged replica did not take, so no step may be lost — the broker re-queues an unacknowledged
/// delivery when the connection carrying it closes, and the peer is there to take it.
/// </para>
/// <para>
/// <b>A negative result is a result.</b> If the client's automatic recovery is fast enough that the
/// wedge never becomes visible at the boards' 15s resolution, that is a resilience finding about
/// this stack and belongs in `grafana/README.md` as one. It is not a reason to widen a window or
/// lengthen a fault until a panel agrees.
/// </para>
/// </summary>
[Trait("Category", Chaos.Category)]
[Collection(Chaos.Category)]
public sealed class WedgedReplicaScenarioTests
{
    [Fact]
    public async Task NoStepIsLostWhileOneProcessorReplicaIsDisconnectedFromTheBroker()
    {
        Chaos.SkipUnlessEnabled();

        var result = await OrchestrationSoak.RunAsync(
            new FaultSchedule(
                FaultKind.Rabbit,
                ClusterControl.HoldOneProcessorDisconnectedAsync),
            TestContext.Current.CancellationToken);

        OutageVerdict.AssertNoUnaccountedLoss(result);
    }
}
