using OpenTelemetry;
using OpenTelemetry.Metrics;

namespace BaseApi.Tests.Support;

/// <summary>
/// Records which instruments actually reached an exporter, and with how many points.
/// <para>
/// <b>Why a real provider rather than <see cref="MetricCollector"/>.</b> A
/// <c>MeterListener</c> sees every measurement published while it is subscribed, and a test
/// constructs its listener first — so a seed recorded before any listener existed still shows up.
/// Production has the opposite ordering: hosted-service constructors all run before the host calls
/// <c>StartAsync</c> on any of them, and the OpenTelemetry hosted service is what builds the
/// <see cref="MeterProvider"/>. A measurement taken in a constructor therefore has no reader at
/// all. Only an exporter behind a real provider can observe that difference.
/// </para>
/// </summary>
internal sealed class ExportedSeriesExporter : BaseExporter<Metric>
{
    private readonly Dictionary<string, int> _points = [];

    /// <summary>Instrument names that exported at least one metric point.</summary>
    public IReadOnlyCollection<string> Instruments => _points.Keys;

    public int PointsFor(string instrument) =>
        _points.TryGetValue(instrument, out var count) ? count : 0;

    public override ExportResult Export(in Batch<Metric> batch)
    {
        foreach (var metric in batch)
        {
            var points = 0;
            foreach (ref readonly var point in metric.GetMetricPoints())
            {
                _ = point;
                points++;
            }

            if (points > 0)
            {
                _points[metric.Name] = _points.GetValueOrDefault(metric.Name) + points;
            }
        }

        return ExportResult.Success;
    }
}
