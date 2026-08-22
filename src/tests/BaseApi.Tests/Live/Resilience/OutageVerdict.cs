using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// The three obligations an outage scenario must meet. Shared by S2, S3 and S4, which differ only in
/// what they take away.
/// </summary>
internal static class OutageVerdict
{
    public static void AssertNoUnaccountedLoss(SoakResult result)
    {
        ArgumentNullException.ThrowIfNull(result);

        var report = SoakReport.Describe(result);

        Assert.True(result.Runs.Count >= 9,
            $"expected at least 9 fires in five minutes at a 30s cron, saw {result.Runs.Count}.\n{report}");

        // Obligation 1. A run that never met the fault has no excuse, and RunClassifier already
        // refuses to spend one on it — so anything short and clear of the window lands here.
        var clearOfWindow = result.Runs
            .Where(r => !r.Straddles && r.Verdict != RunVerdict.Complete)
            .ToList();

        Assert.True(clearOfWindow.Count == 0,
            $"{clearOfWindow.Count} run(s) outside the fault window were incomplete. A run that never "
            + $"met the outage has no excuse.\n{report}");

        // Obligation 2. Inside the window a run may be short, but only with a record saying why.
        var unaccounted = result.Runs.Where(r => r.Verdict == RunVerdict.Unaccounted).ToList();

        Assert.True(unaccounted.Count == 0,
            $"{unaccounted.Count} run(s) lost steps with nothing on the run to account for it. "
            + $"This is the loss the scenario exists to detect.\n{report}");

        // Obligation 3. The pipeline heals within one cron period.
        var afterHeal = result.Runs
            .Where(r => r.Ledger.StartedAt > result.Window.HealedAt)
            .ToList();

        Assert.True(afterHeal.Count > 0,
            $"no run began after the fault healed at {result.Window.HealedAt:o}, so recovery was "
            + $"never exercised. Lengthen the soak or shorten the outage.\n{report}");

        Assert.True(afterHeal[0].Verdict == RunVerdict.Complete,
            $"the first run after the heal ({afterHeal[0].Ledger.CorrelationId}) was "
            + $"{afterHeal[0].Verdict}; the pipeline did not recover within one cron period.\n{report}");
    }
}
