using BaseApi.Service.Features.Liveness;
using Xunit;

namespace BaseApi.Tests.Liveness;

/// <summary>The hub's state: changes only, each with the next sequence number, and snapshots that agree with them.</summary>
public sealed class LivenessStateTests
{
    private static readonly Guid Wf1 = Guid.Parse("00000000-0000-0000-0000-000000000001");
    private static readonly Guid Wf2 = Guid.Parse("00000000-0000-0000-0000-000000000002");
    private static readonly Guid P1 = Guid.Parse("00000000-0000-0000-0000-0000000000a1");
    private static readonly Guid P2 = Guid.Parse("00000000-0000-0000-0000-0000000000a2");

    private static ProcessorLivenessStateDto Live(Guid id, int healthy = 1, int replicas = 1) => new(id, true, healthy, replicas, null);
    private static ProcessorLivenessStateDto Dead(Guid id, string reason = "no healthy replica (1 checked: 0 absent, 0 unhealthy, 1 stale, 0 malformed)") => new(id, false, 0, 1, reason);

    private static LivenessReading Reading(Guid[] running, params ProcessorLivenessStateDto[] processors) =>
        new(running.ToHashSet(), processors.ToDictionary(p => p.ProcessorId));

    [Fact]
    public void TheFirstReadingSaysKnownOnceAndBroadcastsNoEntityChange()
    {
        var state = new LivenessState();
        Assert.False(state.FirstReading.IsCompleted);

        var changes = state.Apply(Reading([Wf1], Live(P1)));

        Assert.Equal([new MonitorStatusDto(true, null, 1)], changes);
        Assert.True(state.FirstReading.IsCompletedSuccessfully);
        Assert.Equal(new LivenessSnapshotDto(1, true, [Wf1], [Live(P1)]), state.Snapshot(), new SnapshotComparer());
    }

    [Fact]
    public void AnEqualReadingBroadcastsNothing()
    {
        var state = new LivenessState();
        state.Apply(Reading([Wf1], Live(P1)));

        Assert.Empty(state.Apply(Reading([Wf1], Live(P1))));
        Assert.Equal(1, state.Sequence);
    }

    [Fact]
    public void WorkflowsStartedAndStoppedAreBroadcastByIdWithIncreasingSequenceNumbers()
    {
        var state = new LivenessState();
        state.Apply(Reading([Wf2]));

        var changes = state.Apply(Reading([Wf1]));

        Assert.Equal<object>([new WorkflowLiveDto(Wf1, true, 2), new WorkflowLiveDto(Wf2, false, 3)], changes);
        Assert.Equal(3, state.Snapshot().Sequence);
        Assert.Equal([Wf1], state.Snapshot().RunningWorkflowIds);
    }

    [Fact]
    public void AProcessorChangeInLiveHealthyReplicasOrReasonIsBroadcastAndARemovedRowIsSaidRemoved()
    {
        var state = new LivenessState();
        state.Apply(Reading([], Live(P1), Live(P2)));

        Assert.Equal<object>([new ProcessorLivenessChangeDto(P1, false, 0, 1, Dead(P1).Reason, false, 2)], state.Apply(Reading([], Dead(P1), Live(P2))));
        Assert.Equal<object>([new ProcessorLivenessChangeDto(P1, false, 0, 1, "other", false, 3)], state.Apply(Reading([], Dead(P1, "other"), Live(P2))));
        Assert.Equal<object>([new ProcessorLivenessChangeDto(P2, true, 1, 2, null, false, 4)], state.Apply(Reading([], Dead(P1, "other"), Live(P2, 1, 2))));
        Assert.Equal<object>([new ProcessorLivenessChangeDto(P2, true, 2, 2, null, false, 5)], state.Apply(Reading([], Dead(P1, "other"), Live(P2, 2, 2))));
        Assert.Equal<object>([new ProcessorLivenessChangeDto(P2, false, 0, 0, null, true, 6)], state.Apply(Reading([], Dead(P1, "other"))));
        Assert.Equal([Dead(P1, "other")], state.Snapshot().Processors);
    }

    [Fact]
    public void FailuresKeepTheStateAndSayUnknownOnceAtTheThresholdThenKnownAgainWithTheChangesSinceTheLastReading()
    {
        var state = new LivenessState();
        state.Apply(Reading([Wf1], Live(P1)));

        Assert.Null(state.Fail("boom", unknownAfter: 2));
        Assert.True(state.Snapshot().Known);
        Assert.Equal(new MonitorStatusDto(false, "boom", 2), state.Fail("boom", unknownAfter: 2));
        Assert.Null(state.Fail("boom", unknownAfter: 2));

        var unknown = state.Snapshot();
        Assert.False(unknown.Known);
        Assert.Equal([Wf1], unknown.RunningWorkflowIds);   // the last reading is kept
        Assert.Equal(2, unknown.Sequence);

        var changes = state.Apply(Reading([], Dead(P1)));
        Assert.Equal<object>([
            new MonitorStatusDto(true, null, 3),
            new WorkflowLiveDto(Wf1, false, 4),
            new ProcessorLivenessChangeDto(P1, false, 0, 1, Dead(P1).Reason, false, 5),
        ], changes);
    }

    [Fact]
    public void ASuccessfulReadingResetsTheFailureCount()
    {
        var state = new LivenessState();
        state.Apply(Reading([]));
        Assert.Null(state.Fail("a", unknownAfter: 2));
        state.Apply(Reading([]));
        Assert.Null(state.Fail("b", unknownAfter: 2));
        Assert.True(state.Snapshot().Known);
    }

    [Fact]
    public void BeforeAnyReadingTheSnapshotIsUnknownAndEmptyAndFailuresSayNothing()
    {
        var state = new LivenessState();
        Assert.Null(state.Fail("no redis", unknownAfter: 1));
        Assert.Equal(new LivenessSnapshotDto(0, false, [], []), state.Snapshot(), new SnapshotComparer());
    }

    /// <summary>Records compare their lists by reference; this compares them by content.</summary>
    private sealed class SnapshotComparer : IEqualityComparer<LivenessSnapshotDto>
    {
        public bool Equals(LivenessSnapshotDto? x, LivenessSnapshotDto? y) =>
            x is not null && y is not null && x.Sequence == y.Sequence && x.Known == y.Known
            && x.RunningWorkflowIds.SequenceEqual(y.RunningWorkflowIds) && x.Processors.SequenceEqual(y.Processors);

        public int GetHashCode(LivenessSnapshotDto obj) => obj.Sequence.GetHashCode();
    }
}
