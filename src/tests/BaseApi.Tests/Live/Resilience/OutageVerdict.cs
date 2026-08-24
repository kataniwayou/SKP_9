using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// The three obligations an outage scenario must meet. Shared by S2, S3 and S4, which differ only in
/// what they take away.
/// </summary>
internal static class OutageVerdict
{
    /// <param name="result">The soak's runs and its witnessed fault window.</param>
    /// <param name="minimumRuns">
    /// The fewest fires this scenario can legitimately produce. Nine for a fault that leaves the
    /// orchestrator scheduling — the soak's ten fires all still happen, and one fire of slop is
    /// allowed for where t0 lands against the cron boundary. Lower only where the fault stops fires
    /// happening at all: a fire that never happened is not a lost step, and the ledger has no run to
    /// judge. See spec section 5.8.
    /// </param>
    /// <summary>
    /// The obligation for a fault that is not supposed to disturb the pipeline at all: every run
    /// whole, no excuses available.
    /// </summary>
    /// <remarks>
    /// <b>Not a weaker <see cref="AssertNoUnaccountedLoss"/> — a different one, and stricter.</b>
    /// That method allows a run inside the fault window to be short provided a record accounts for
    /// it, and it *requires* a witnessed window: its third obligation asks for a run beginning after
    /// <c>Window.HealedAt</c>, and a scenario carrying <see cref="FaultKind.None"/> gets
    /// <see cref="FaultWindow.None"/>, whose <c>HealedAt</c> is <see cref="DateTimeOffset.MaxValue"/>.
    /// Nothing can begin after that, so the two are mutually exclusive by construction rather than
    /// by judgement — asking for both produces "no run began after the fault healed at
    /// 9999-12-31", which reads like a timing problem and is not one.
    /// <para>
    /// Use this where the claim is that the fault never reaches the pipeline: a dependency slow
    /// enough to notice but not slow enough to trip anything. There is no window to straddle, so
    /// every run is held to the undisturbed standard.
    /// </para>
    /// </remarks>
    public static void AssertEveryRunComplete(SoakResult result, int minimumRuns = 9)
    {
        ArgumentNullException.ThrowIfNull(result);

        var report = SoakReport.Describe(result);

        Assert.True(result.Runs.Count >= minimumRuns,
            $"expected at least {minimumRuns} fires in five minutes at a 30s cron, "
            + $"saw {result.Runs.Count}.\n{report}");

        var incomplete = result.Runs.Where(r => r.Verdict != RunVerdict.Complete).ToList();

        Assert.True(incomplete.Count == 0,
            $"{incomplete.Count} run(s) were incomplete while the dependency was merely slow. "
            + "Nothing was taken away, so there is no excuse available for a short run.\n"
            + report);
    }

    public static void AssertNoUnaccountedLoss(SoakResult result, int minimumRuns = 9)
    {
        ArgumentNullException.ThrowIfNull(result);

        var report = SoakReport.Describe(result);

        Assert.True(result.Runs.Count >= minimumRuns,
            $"expected at least {minimumRuns} fires in five minutes at a 30s cron, "
            + $"saw {result.Runs.Count}.\n{report}");

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
