using System.Linq;
using System.Text.Json;
using Messaging.Contracts;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

public sealed class OrchestratorFanoutTests
{
    [Fact]
    public void ThreeReplicasGetThreeDistinctQueueNames()
    {
        // The silent-degradation guard. These queues are non-exclusive, so two replicas resolving to
        // the SAME name raises nothing — it quietly turns the broadcast into a competing-consumer
        // load-balance, each announcement reaching one replica instead of three, with the other two
        // holding stale L1 and stale schedules and nothing in the transport reporting it. The broker
        // cannot tell us; only this assertion can.
        var names = new[]
        {
            OrchestratorFanout.PerReplica("orchestrator-0"),
            OrchestratorFanout.PerReplica("orchestrator-1"),
            OrchestratorFanout.PerReplica("orchestrator-2"),
        };

        Assert.Equal(3, names.Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public void ThePerReplicaNameIsStableForAGivenReplica()
    {
        // A restarted pod at the same StatefulSet ordinal must reclaim its own queue and drain what
        // buffered while it was away, rather than minting a new one and abandoning the backlog.
        Assert.Equal(
            OrchestratorFanout.PerReplica("orchestrator-1"),
            OrchestratorFanout.PerReplica("orchestrator-1"));
    }

    [Fact]
    public void ADeadQueueIsNamedAfterTheQueueItParksFor()
    {
        Assert.Equal(
            OrchestratorFanout.PerReplica("orchestrator-0") + ".dead",
            OrchestratorFanout.Dead("orchestrator-0"));
    }

    [Fact]
    public void APerReplicaNameNeverCollidesWithAnExistingSharedQueue()
    {
        // A replica id that resolved onto one of the shared competing-consumer endpoints would inject
        // announcements into live pipeline traffic. Nothing about the charset prevents it, so it is
        // asserted against the real constants rather than against literals.
        foreach (var id in new[] { "result", "control", "0" })
        {
            var name = OrchestratorFanout.PerReplica(id);
            Assert.NotEqual(OrchestratorQueues.Result, name);
            Assert.NotEqual(OrchestratorQueues.ResultPost, name);
            Assert.NotEqual(OrchestratorQueues.Control, name);
        }
    }

    [Fact]
    public void AnAnnouncementRoundTripsCarryingOnlyAWorkflowId()
    {
        // It announces that L2 has already been written. Carrying the definition would let a replica
        // apply a stale graph after a newer write; carrying only the id forces the re-read.
        var id = Guid.Parse("11111111-1111-1111-1111-111111111111");
        var json = JsonSerializer.SerializeToUtf8Bytes(new OrchestrationStarted(id), MessagingJson.Options);
        var back = JsonSerializer.Deserialize<OrchestrationStarted>(json, MessagingJson.Options);

        Assert.Equal(id, back!.WorkflowId);
    }
}
