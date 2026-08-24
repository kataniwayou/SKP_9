using OpenTelemetry;
using OpenTelemetry.Metrics;

namespace BaseApi.Tests.Support;

/// <summary>
/// Reads the explicit bucket boundaries off whatever histograms are exported.
/// <para>
/// <b>Why the boundaries are read back rather than the wiring inspected.</b> A view whose instrument
/// name matches nothing is silently ignored — no error, no warning — so asserting that the wiring
/// calls <c>AddView</c> would prove nothing at all. Reading the ladder off an exported metric is
/// only possible if the view both exists and matched the instrument.
/// </para>
/// <para>
/// Shared rather than nested in one test class because two histograms now need it — the transport's
/// send duration and the gate probe's — and a second copy is exactly the drift the production side
/// of this repo goes out of its way to prevent.
/// </para>
/// </summary>
internal sealed class BoundaryCapturingExporter : BaseExporter<Metric>
{
    private readonly Dictionary<string, double[]> _boundaries = [];

    public double[]? BoundariesFor(string instrument) =>
        _boundaries.TryGetValue(instrument, out var b) ? b : null;

    public override ExportResult Export(in Batch<Metric> batch)
    {
        foreach (var metric in batch)
        {
            if (metric.MetricType != MetricType.Histogram)
            {
                continue;
            }

            foreach (ref readonly var point in metric.GetMetricPoints())
            {
                var bounds = new List<double>();
                foreach (var bucket in point.GetHistogramBuckets())
                {
                    if (!double.IsPositiveInfinity(bucket.ExplicitBound))
                    {
                        bounds.Add(bucket.ExplicitBound);
                    }
                }

                _boundaries[metric.Name] = [.. bounds];
                break;
            }
        }

        return ExportResult.Success;
    }
}
