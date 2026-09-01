using BaseConsole.Core.Messaging;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
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
    public void TheLeaseNameIsFixed()
    {
        // Nothing feeds the lease's NAME: all three replicas must contend for the same object, and a
        // name that could differ between them would give each its own lease and therefore its own
        // leadership. The namespace is configurable (below) only because the manifest binds it to the
        // pod's own namespace, which one pod template cannot vary across replicas.
        Assert.Equal("orchestrator-leader", LeaderElectionService.LeaseName);
    }

    [Fact]
    public void TheLeaseNamespaceFallsBackWhenUnconfigured()
    {
        // The off-cluster shape. Absent is legal rather than fatal: the election is registered only
        // in-cluster, so a local run has no namespace to require.
        Assert.Equal("skp", LeaderElectionService.DefaultLeaseNamespace);
        Assert.Equal("skp", Service(configured: null).LeaseNamespace);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void ABlankLeaseNamespaceFallsBackRatherThanPassingThrough(string configured)
    {
        // An environment variable set to the empty string is a deployment mistake, and a Lease
        // request against an empty namespace fails in a way that reads as an RBAC problem rather
        // than as the typo it is.
        Assert.Equal("skp", Service(configured).LeaseNamespace);
    }

    [Fact]
    public void TheLeaseNamespaceBindsFromConfiguration()
    {
        // What the manifest's downward-API binding actually exercises: whatever namespace this
        // StatefulSet was deployed into is the namespace the Lease is taken in, and therefore the
        // one whose Role grants leases get/update/create.
        Assert.Equal("other-ns", Service("other-ns").LeaseNamespace);
    }

    /// <summary>
    /// The service with nothing but its configuration wired. <c>ExecuteAsync</c> is never called, so
    /// no <c>IKubernetes</c> is ever constructed and the no-Kubernetes stance above holds.
    /// </summary>
    private static LeaderElectionService Service(string? configured)
    {
        var settings = configured is null
            ? new Dictionary<string, string?>()
            : new Dictionary<string, string?>
            {
                [LeaderElectionService.LeaseNamespaceKey] = configured,
            };

        return new LeaderElectionService(
            new LeaderState(),
            new InstanceId("test-replica"),
            new ConfigurationBuilder().AddInMemoryCollection(settings).Build(),
            NullLogger<LeaderElectionService>.Instance);
    }
}
