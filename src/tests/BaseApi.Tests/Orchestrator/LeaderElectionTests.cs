using Orchestrator.Election;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// The leadership gate, without an election.
/// <para>
/// <b>There is deliberately no Kubernetes here.</b> The election service is registered only when the
/// replica runs in-cluster, so nothing hermetic ever stands one up; what a test can assert is the two
/// things that do not need one — that the state the callbacks write behaves as a gate, and that the
/// timings the callbacks are configured with satisfy the fence they exist to provide. The live
/// election is proven against a cluster, not here.
/// </para>
/// </summary>
public sealed class LeaderElectionTests
{
    [Fact]
    public void TheRenewDeadlineIsBelowTheLeaseDuration()
    {
        // The self-demotion fence. A leader that loses its lease must close its own gate within the
        // renew window rather than discovering it later and dispatching alongside the new leader.
        Assert.True(LeaderElectionService.RenewDeadline < LeaderElectionService.LeaseDuration);
    }

    [Fact]
    public void AReplicaIsAFollowerUntilItHasWonSomething()
    {
        // The pre-acquisition state, and the reason it is the default: three replicas start together
        // and contend for one lease, so a replica that assumed leadership until told otherwise would
        // have all three dispatching for the seconds before the first lease is granted.
        Assert.False(new LeaderState().IsLeader);
    }

    [Fact]
    public void TheGateOpensAndClosesWithTheElectionCallbacks()
    {
        // Both directions, in one test, because closing is the half that matters: a gate that opened
        // on acquisition and never closed on loss would put two leaders on the same workflow for as
        // long as the demoted replica kept running.
        var state = new LeaderState();

        state.BecomeLeader();
        Assert.True(state.IsLeader);

        state.BecomeFollower();
        Assert.False(state.IsLeader);
    }

    [Fact]
    public void TheLeaseCoordinatesAreFixed()
    {
        // Nothing dynamic and nothing configurable feeds the lease's namespace or name: all three
        // replicas must contend for the same object, and a value that could differ between them would
        // give each its own lease and therefore its own leadership.
        Assert.Equal("skp", LeaderElectionService.LeaseNamespace);
        Assert.Equal("orchestrator-leader", LeaderElectionService.LeaseName);
    }
}
