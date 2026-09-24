namespace Processor.Analyst.Panels;

/// <summary>The window a reading covers.</summary>
internal sealed record TimeRange(DateTimeOffset From, DateTimeOffset To);

/// <summary>What a panel is, as the model is told about it. <paramref name="Layer"/> is "business" or "ops".</summary>
internal sealed record PanelDescriptor(string PanelId, string Layer, string Description);

/// <summary>
/// Whether a reading can be believed.
/// <para>
/// <b>This is not decoration.</b> A dead port-forward keeps the socket bound, so the port looks free
/// and then refuses connections. A panel missing one series renders perfectly healthy. A stopped load
/// generator makes a flat arrival line that is absence of load, not absence of problems. An agent
/// handed bare numbers reports every one of those as a confident conclusion.
/// </para>
/// </summary>
/// <param name="SeriesPresent">The series the panel names actually existed in the response.</param>
/// <param name="WindowFullyCovered">Data spanned the whole requested range, not a truncated part of it.</param>
/// <param name="NoDataDistinguishable">
/// Whether "nothing happened" could be told apart from "nothing reported".
/// <para>
/// <b>On a Prometheus reading this is NOT an independent signal.</b> A counter or histogram that was
/// scraped but never incremented, and the identical query over a label combination that was never
/// observed at all (a dead replica; a metrics regression), both come back as an empty
/// <c>query_range</c> result on this system — Prometheus client libraries only materialise a series
/// once an observation with that exact label set occurs, and nothing here zero-seeds one. So on a
/// Prometheus-backed <see cref="PanelReading"/> this flag tracks <see cref="SeriesPresent"/> exactly
/// and adds no information beyond it: a present series is trustworthy telemetry (including a
/// legitimate zero), an absent one is never distinguishable from a blind spot, no matter which of the
/// two it actually is. Only Elasticsearch can independently draw this line — a clean zero-count
/// aggregation over documents that undeniably exist in the same window is a shape Prometheus cannot
/// produce. Do not let a quiet Prometheus panel alone be read as "confirmed nothing happened."
/// </para>
/// </param>
internal sealed record PanelTrust(bool SeriesPresent, bool WindowFullyCovered, bool NoDataDistinguishable);

/// <summary>One panel consultation's result.</summary>
internal sealed record PanelReading(
    string PanelId,
    string Layer,
    string ValueJson,
    int SampleCount,
    PanelTrust Trust);

/// <summary>
/// The panel could not be read at all. Distinct from a reading whose trust flags are poor: this one
/// means the evidence source was unreachable, which makes the analysis impossible rather than
/// inconclusive, and the loop turns it into a failed step.
/// </summary>
internal sealed class PanelUnavailableException(string panelId, string why)
    : Exception($"panel '{panelId}' could not be read: {why}")
{
    internal string PanelId { get; } = panelId;
}
