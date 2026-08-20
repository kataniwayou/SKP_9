using Orchestrator.Scheduling;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// The scheduler's fire-time math. The null returns are the load-bearing part: a hydration loop walks
/// every workflow in L2 in turn, and an expression that cannot be parsed must cost that loop one
/// skipped workflow, not the whole pass.
/// </summary>
public sealed class CronIntervalTests
{
    private static readonly DateTime Now = new(2026, 8, 20, 12, 30, 0, DateTimeKind.Utc);

    [Fact]
    public void ReturnsTheNextOccurrenceOfAFiveFieldExpression()
    {
        Assert.Equal(
            new DateTime(2026, 8, 20, 13, 0, 0, DateTimeKind.Utc),
            CronInterval.NextOccurrence("0 * * * *", Now));
    }

    [Fact]
    public void ReturnsTheNextOccurrenceOfASixFieldSecondsExpression()
    {
        Assert.Equal(
            new DateTime(2026, 8, 20, 12, 30, 15, DateTimeKind.Utc),
            CronInterval.NextOccurrence("15 * * * * *", Now));
    }

    [Fact]
    public void ComputesAnAbsoluteOccurrenceRatherThanAnIntervalFromNow()
    {
        // Spec §7.2 leans on this: a redelivered start reschedules off the same wall-clock fire time,
        // so repeated redeliveries cannot push a workflow's next fire further and further out.
        Assert.Equal(
            CronInterval.NextOccurrence("0 * * * *", Now),
            CronInterval.NextOccurrence("0 * * * *", Now.AddMinutes(5)));
    }

    [Fact]
    public void ReturnsNullWhenTheExpressionHasNoFutureOccurrence()
    {
        // The thirtieth of February parses, and never happens.
        Assert.Null(CronInterval.NextOccurrence("0 0 30 2 *", Now));
    }

    [Fact]
    public void ReturnsNullRatherThanThrowingOnAnUnparseableExpression()
    {
        // A bad cron reached L2 through validation; a throw here would kill a hydration pass rather
        // than skip one workflow.
        Assert.Null(CronInterval.NextOccurrence("@ @ @ @ @", Now));
    }

    [Fact]
    public void ReturnsNullOnAnExpressionWithNeitherFiveNorSixFields()
    {
        Assert.Null(CronInterval.NextOccurrence("* * *", Now));
        Assert.Null(CronInterval.NextOccurrence("   ", Now));
    }
}
