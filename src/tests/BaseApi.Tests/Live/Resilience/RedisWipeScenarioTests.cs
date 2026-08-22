using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// S5. Redis is scaled to zero, which does not make L2 unavailable — it destroys it.
/// <para>
/// <b>Why this is its own scenario and not a variant of S2.</b> Redis runs with
/// --save "" --appendonly no and has no volumeClaimTemplates: persistence is off by design. Scaling
/// to zero therefore takes every in-flight step blob, the projected workflow, and every processor
/// liveness key with it. A redelivered dispatch then finds its entry gone, and the processor logs
/// "entry absent - treating as a duplicate delivery" and drops it. That is a genuinely lost step
/// which, in the logs, is indistinguishable from correct duplicate suppression.
/// </para>
/// <para>
/// So "no lost steps" is unachievable here — not because the system is broken, but because the fault
/// destroyed the state recovery would have used. What is worth asserting instead is that the blast
/// radius is bounded, that the wipe is visible, and that recovery is total.
/// </para>
/// </summary>
[Trait("Category", Chaos.Category)]
[Collection(Chaos.Category)]
public sealed class RedisWipeScenarioTests
{
    [Fact]
    public async Task TheWipeIsBoundedVisibleAndFullyRecoveredFrom()
    {
        Chaos.SkipUnlessEnabled();

        var result = await OrchestrationSoak.RunAsync(
            new FaultSchedule(
                FaultKind.Redis,
                ct => ClusterControl.HoldScaledDownAsync("statefulset", "redis", 1, ct)),
            TestContext.Current.CancellationToken);

        var report = SoakReport.Describe(result);

        Assert.True(result.Runs.Count >= 9,
            $"expected at least 9 fires in five minutes at a 30s cron, saw {result.Runs.Count}. "
            + "A soak that barely fired would satisfy every assertion below without proving "
            + $"anything.\n{report}");

        // Bounded: nothing clear of the window may be short. The wipe must not reach past itself.
        var clearOfWindow = result.Runs
            .Where(r => !r.Straddles && r.Verdict != RunVerdict.Complete)
            .ToList();

        Assert.True(clearOfWindow.Count == 0,
            $"{clearOfWindow.Count} run(s) outside the wipe window were incomplete; the blast radius "
            + $"is wider than the outage.\n{report}");

        // Recovery is total: the first fire after the heal walks the whole graph again, which also
        // proves the processor rewrote its liveness key and the orchestrator resumed dispatching.
        var afterHeal = result.Runs
            .Where(r => r.Ledger.StartedAt > result.Window.HealedAt)
            .ToList();

        Assert.True(afterHeal.Count > 0,
            $"no run began after the wipe healed at {result.Window.HealedAt:o}.\n{report}");

        Assert.True(afterHeal[0].Verdict == RunVerdict.Complete,
            $"the first run after the wipe ({afterHeal[0].Ledger.CorrelationId}) was "
            + $"{afterHeal[0].Verdict}; the pipeline did not recover from an empty L2.\n{report}");

        // Visible: report what the wipe cost rather than asserting a number. The count is a property
        // of where the outage landed relative to the cron, not of the system's correctness, so
        // pinning it would make this test fail on timing.
        var truncated = result.Runs.Where(r => r.Straddles && r.Verdict != RunVerdict.Complete).ToList();

        TestContext.Current.TestOutputHelper?.WriteLine(
            $"the L2 wipe truncated {truncated.Count} run(s) of {result.Runs.Count}.\n{report}");

        // Conditional, deliberately. Whether the wipe catches a step mid-flight depends on where the
        // outage lands relative to the cron, so asserting that it always does would make this test
        // fail on timing. But IF it truncated a run, that run must say why -- an L2 wipe that
        // silently swallowed a step, with nothing on the record naming it, is exactly the outcome
        // this scenario exists to rule out.
        foreach (var run in truncated)
        {
            Assert.True(run.Excuses.Count > 0,
                $"run {run.Ledger.CorrelationId} was truncated by the wipe with nothing accounting "
                + $"for it.\n{report}");
        }
    }
}
