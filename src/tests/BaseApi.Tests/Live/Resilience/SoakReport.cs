using System.Globalization;
using System.Text;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// Renders a soak so a failure arrives with its evidence attached.
/// <para>
/// A five-minute scenario against a shared cluster is expensive to repeat, so a failure that says
/// only "expected Complete" costs another five minutes to understand. The breaches name the hop and
/// the metrics say whether the fault landed.
/// </para>
/// </summary>
internal static class SoakReport
{
    public static string Describe(SoakResult result)
    {
        ArgumentNullException.ThrowIfNull(result);

        var report = new StringBuilder();
        report.AppendLine(CultureInfo.InvariantCulture,
            $"soak {result.StartedAt:o} .. {result.StoppedAt:o}");
        report.AppendLine(result.Window.IsNone
            ? "fault window: none"
            : $"fault window: {result.Window.FaultAt:o} .. {result.Window.HealedAt:o} (observed)");
        report.AppendLine(CultureInfo.InvariantCulture, $"runs: {result.Runs.Count}");

        foreach (var group in result.Runs.GroupBy(r => r.Verdict))
        {
            report.AppendLine(CultureInfo.InvariantCulture, $"  {group.Key}: {group.Count()}");
        }

        // Excluded, not silently dropped: a run this close to the soak's own stop was truncated by
        // ApplyStopHandler removing the workflow from L1, not by the fault under test, so it never
        // entered judgment above -- see OrchestrationSoak.StopGuard. Named here so the count is
        // visible instead of making the run total look smaller than what Elasticsearch actually held.
        report.AppendLine(CultureInfo.InvariantCulture,
            $"cut short by our own stop (excluded from judgment): {result.CutShortByStop.Count}");

        foreach (var run in result.CutShortByStop)
        {
            report.AppendLine(CultureInfo.InvariantCulture,
                $"  {run.Ledger.CorrelationId} started {run.Ledger.StartedAt:HH:mm:ss}");
        }

        foreach (var run in result.Runs.Where(r => r.Verdict != RunVerdict.Complete))
        {
            report.AppendLine(CultureInfo.InvariantCulture,
                $"  {run.Ledger.CorrelationId} {run.Verdict} "
                + $"(straddles={run.Straddles}) {run.Ledger.StartedAt:HH:mm:ss}");

            foreach (var breach in run.Ledger.Breaches)
            {
                report.AppendLine(CultureInfo.InvariantCulture, $"      {breach.Invariant}: {breach.Detail}");
            }

            foreach (var excuse in run.Excuses)
            {
                report.AppendLine(CultureInfo.InvariantCulture, $"      excuse: {excuse}");
            }
        }

        report.AppendLine("metrics (corroboration only):");
        foreach (var (label, value) in result.Metrics)
        {
            report.AppendLine(CultureInfo.InvariantCulture,
                $"  {label}: {(value is null ? "no series" : value.Value.ToString(CultureInfo.InvariantCulture))}");
        }

        return report.ToString();
    }
}
