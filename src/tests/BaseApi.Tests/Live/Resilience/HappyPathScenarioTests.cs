using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// S1. Five minutes of undisturbed orchestration, every run whole.
/// <para>
/// This is the scenario the other four are measured against. If the round trip drops a step with
/// nothing broken, no outage result below carries any information.
/// </para>
/// </summary>
[Trait("Category", Chaos.Category)]
public sealed class HappyPathScenarioTests
{
    [Fact]
    public async Task EveryRunCompletesWhenNothingIsTakenAway()
    {
        Chaos.SkipUnlessEnabled();

        var result = await OrchestrationSoak.RunAsync(
            FaultSchedule.None, TestContext.Current.CancellationToken);

        var report = SoakReport.Describe(result);

        Assert.True(result.Runs.Count >= 9,
            $"expected at least 9 fires in five minutes at a 30s cron, saw {result.Runs.Count}.\n{report}");

        Assert.All(result.Runs, run =>
            Assert.True(run.Verdict == RunVerdict.Complete,
                $"run {run.Ledger.CorrelationId} was {run.Verdict}: "
                + $"{string.Join("; ", run.Ledger.Breaches.Select(b => $"{b.Invariant} {b.Detail}"))}"));
    }
}
