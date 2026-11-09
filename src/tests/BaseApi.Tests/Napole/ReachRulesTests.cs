using Processor.Napole;
using Xunit;

namespace BaseApi.Tests.Napole;

public sealed class ReachRulesTests
{
    private static ExecutionTrail T(long roots, long reached, long endC, long endF, long endX, long wayF, long wayX)
        => new(Guid.NewGuid(), roots, reached, endC, endF, endX, wayF, wayX);

    private static void Expect(ExecutionTrail trail, Reach reach, Contribution contribution)
    {
        Assert.Equal(reach, ReachRules.Classify(trail));
        Assert.Equal(contribution, ReachRules.Count(trail));
    }

    [Fact]
    public void TwoArrivalsAtTheEndAddTwo()
        // The split chain's good file: both branches reach split-exporter. No deduplication (reach spec §2.2).
        => Expect(T(1, 2, 2, 0, 0, 0, 0), Reach.Reached, new(1, 2, 0, 0));

    [Fact]
    public void MixedOutcomesAtTheEndAreEachCounted()
        // One arrival completed, one failed at the end itself; the way failure is not counted once reached.
        => Expect(T(1, 2, 1, 1, 0, 1, 0), Reach.Reached, new(1, 1, 1, 0));

    [Fact]
    public void AFailureElsewhereInAReachedExecutionIsNotCounted()
        // Reached -> only toStepId's outcomes count, whatever another branch did (reach spec §2.2).
        => Expect(T(1, 1, 1, 0, 0, 1, 1), Reach.Reached, new(1, 1, 0, 0));

    [Fact]
    public void ACancelAtTheEndIsDiscarded() => Expect(T(1, 1, 0, 0, 1, 0, 1), Reach.Reached, new(1, 0, 0, 1));

    [Fact]
    public void TwoFailuresOnTheWayAddTwo()
        // Never reached; one failure on each branch, counted per step outcome.
        => Expect(T(1, 0, 0, 0, 0, 2, 0), Reach.EndedOnTheWay, new(1, 0, 2, 0));

    [Fact]
    public void ACancelOnTheWayIsDiscarded() => Expect(T(1, 0, 0, 0, 0, 0, 1), Reach.EndedOnTheWay, new(1, 0, 0, 1));

    [Fact]
    public void NoProvenEndIsNotInTheReport()
        // Still on its way, or left by another route without failing: not in input, not in a counter.
        => Expect(T(1, 0, 0, 0, 0, 0, 0), Reach.NoProvenEnd, default);

    [Fact]
    public void TwoRootsAreLeftOut()
        // A re-import of one ExecutionId in the trail would mix two runs' outcomes.
        => Expect(T(2, 1, 1, 0, 0, 0, 0), Reach.ReImported, default);

    [Fact]
    public void NoRootButAReachIsCounted()
        // The start record is outside the trail; nothing needs to know whether the run ended any more.
        => Expect(T(0, 1, 1, 0, 0, 0, 0), Reach.Reached, new(1, 1, 0, 0));
}
