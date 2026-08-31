using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Logging;

namespace BaseConsole.Core.Health;

/// <summary>
/// The one line a probe writes, shared in shape — not in code — with
/// <c>BaseApi.Core.Health.HealthProbeLog</c>. Both copies must render identically; the test that
/// feeds the same report to each and compares the strings is what keeps them from drifting.
/// <para>
/// This is duplicated rather than shared because the only projects both cores reference are
/// <c>Messaging.Contracts</c> and <c>Messaging.Transport</c>, and a health-logging helper belongs in
/// neither. <see cref="IStartupGate"/> and <see cref="StartupHealthCheck"/> are already duplicated on
/// the same reasoning.
/// </para>
/// </summary>
public static class HealthProbeLog
{
    /// <summary>
    /// A fixed category rather than the enclosing class, and the whole point of the design: it makes
    /// <c>Logging:LogLevel:HealthProbe</c> one filter key that reaches this line in the API, the
    /// orchestrator and every processor. A per-class category would need three different keys and
    /// would silently stop matching whenever a class was renamed.
    /// </summary>
    public const string Category = "HealthProbe";

    /// <summary>
    /// Renders one probe outcome. <paramref name="statusCode"/> is passed rather than derived,
    /// because it is what the kubelet actually acts on and each caller has already computed it.
    /// </summary>
    public static void Write(ILogger logger, string probe, HealthReport report, int statusCode)
    {
        ArgumentNullException.ThrowIfNull(logger);
        ArgumentNullException.ThrowIfNull(report);

        // Sorted, because HealthReport.Entries is a dictionary and an unsorted join would make the
        // same failure render two different ways between probes.
        var failing = report.Entries
            .Where(e => e.Value.Status != HealthStatus.Healthy)
            .Select(e => e.Key)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();

        // Names only, never a check's description: those are free text and routinely carry a
        // connection string. The endpoint body withholds them for the same reason.
        var detail = failing.Length == 0 ? string.Empty : "; failing: " + string.Join(", ", failing);

        logger.LogInformation(
            "{Probe} probe {Status} ({StatusCode}) in {ElapsedMs:F2}ms{Detail}",
            probe, report.Status, statusCode, report.TotalDuration.TotalMilliseconds, detail);
    }
}
