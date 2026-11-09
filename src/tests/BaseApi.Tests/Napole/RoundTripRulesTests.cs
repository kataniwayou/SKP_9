using Processor.Napole;
using Xunit;

namespace BaseApi.Tests.Napole;

public sealed class RoundTripRulesTests
{
    private static RoundTrip Decide(long roots, long open, long failed, long cancelled, long reached)
        => RoundTripRules.Decide(new ExecutionTrail(Guid.NewGuid(), roots, open, failed, cancelled, reached));

    [Fact]
    public void AWholeSectionIsComplete() => Assert.Equal(RoundTrip.Complete, Decide(1, 0, 0, 0, 1));

    [Fact]
    public void TwoEndsAtTheTerminatorAreOneOutput()
        // The split chain's good file: two branches meet again at split-exporter, so toStepId completes
        // twice for one execution. Counted per execution, it is one output (sections spec §5.4).
        => Assert.Equal(RoundTrip.Complete, Decide(1, 0, 0, 0, 2));

    [Fact]
    public void AFailureThatRanToItsFailureExportIsFailed()
        // record-outcome -> export-outcome completes after the failure; the first failure still decides.
        => Assert.Equal(RoundTrip.Failed, Decide(1, 0, 1, 0, 0));

    [Fact]
    public void AFailureWithABranchStillOpenIsFailed()
        // Failed is decided before open branches (sections spec §5.2): there is no catch-up, so a failed
        // run still running a slow failure branch would otherwise never be reported at all.
        => Assert.Equal(RoundTrip.Failed, Decide(1, 1, 1, 0, 0));

    [Fact]
    public void AFailureAndACancelIsFailed() => Assert.Equal(RoundTrip.Failed, Decide(1, 0, 1, 1, 0));

    [Fact]
    public void AWhitelistCancelIsCancelled() => Assert.Equal(RoundTrip.Cancelled, Decide(1, 0, 0, 1, 0));

    [Fact]
    public void ACancelWithABranchStillOpenIsUnfinished()
        // The branch still in flight may yet fail, which would make the run Failed.
        => Assert.Equal(RoundTrip.Unfinished, Decide(1, 1, 0, 1, 0));

    [Fact]
    public void AnOpenBranchIsUnfinished()
        // One branch reached the terminator, the other has not ended: not yet a terminated run.
        => Assert.Equal(RoundTrip.Unfinished, Decide(1, 1, 0, 0, 1));

    [Fact]
    public void ACleanRunThatNeverReachedTheTerminatorIsBypassed()
        // Finished, nothing failed or cancelled in the section, and toStepId never completed: the run
        // left by another route, so it is in no count (sections spec §5.2, 6).
        => Assert.Equal(RoundTrip.Bypassed, Decide(1, 0, 0, 0, 0));

    [Fact]
    public void TwoRootsAreUnfinished()
        // Two runs of one execution id in the trail -- a re-import -- cannot be told apart.
        => Assert.Equal(RoundTrip.Unfinished, Decide(2, 0, 1, 0, 2));

    [Fact]
    public void NoRootIsUnfinished()
        // The entry's record is outside the trail, so whether every branch ended cannot be known.
        => Assert.Equal(RoundTrip.Unfinished, Decide(0, 0, 0, 0, 1));
}
