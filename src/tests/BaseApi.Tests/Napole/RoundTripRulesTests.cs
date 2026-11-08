using Processor.Napole;
using Xunit;

namespace BaseApi.Tests.Napole;

public sealed class RoundTripRulesTests
{
    private static RoundTrip Decide(long imports, long open, long terminals, long failed, long cancelled)
        => RoundTripRules.Decide(new ExecutionTrail(Guid.NewGuid(), imports, open, terminals, failed, cancelled));

    [Fact]
    public void AFullRoundTripIsComplete() => Assert.Equal(RoundTrip.Complete, Decide(1, 0, 2, 0, 0));

    [Fact]
    public void AFailureThatRanToItsFailureExportIsFailed()
        // record-outcome -> export-outcome ends with a terminal Completed; the first failure still decides.
        => Assert.Equal(RoundTrip.Failed, Decide(1, 0, 1, 1, 0));

    [Fact]
    public void AFailureOnOneBranchAndACancelOnAnotherIsFailed() => Assert.Equal(RoundTrip.Failed, Decide(1, 0, 0, 1, 1));

    [Fact]
    public void AWhitelistCancelIsCancelled() => Assert.Equal(RoundTrip.Cancelled, Decide(1, 0, 0, 0, 1));

    [Fact]
    public void AFanOutWithOneOpenBranchIsUnfinished()
        // One document exported, the other branch still in flight: not a full round trip yet.
        => Assert.Equal(RoundTrip.Unfinished, Decide(1, 1, 1, 0, 0));

    [Fact]
    public void NoTerminalIsUnfinished() => Assert.Equal(RoundTrip.Unfinished, Decide(1, 0, 0, 0, 0));

    [Fact]
    public void TwoImportsInTheTrailAreUnfinished() => Assert.Equal(RoundTrip.Unfinished, Decide(2, 0, 4, 0, 0));

    [Fact]
    public void NoRecordsAtAllAreUnfinished() => Assert.Equal(RoundTrip.Unfinished, Decide(0, 0, 0, 0, 0));

    [Fact]
    public void AFailureWithTwoImportsIsStillUnfinished()
        // Two runs of one id mixed in one trail: whose failure it is cannot be told, so neither counts.
        => Assert.Equal(RoundTrip.Unfinished, Decide(2, 0, 1, 1, 0));
}
