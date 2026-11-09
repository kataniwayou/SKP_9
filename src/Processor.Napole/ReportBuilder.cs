using System.Globalization;
using BaseProcessor.Core.Processing;

namespace Processor.Napole;

public static class ReportBuilder
{
    /// <summary>
    /// The report for one window, or null when no execution in it terminated -- the tick then sends
    /// nothing (spec §6).
    /// <para>
    /// <b>Hermetic by construction, asserted anyway.</b> Each terminated execution is counted once,
    /// under its verdict, so the three counts cannot fail to add up to the input -- but a report
    /// that does not add up must never reach the topic looking plausible, so the identity is checked
    /// before the report leaves here.
    /// </para>
    /// </summary>
    public static NapoleReport? Build(
        ReportWindow window,
        IEnumerable<RoundTrip> verdicts,
        ReportDimensions dimensions,
        string reporterSubComponentName,
        DateTimeOffset insertedAt)
    {
        ArgumentNullException.ThrowIfNull(verdicts);
        ArgumentNullException.ThrowIfNull(dimensions);

        int output = 0, discarded = 0, failed = 0;
        foreach (var verdict in verdicts)
        {
            switch (verdict)
            {
                case RoundTrip.Complete: output++; break;
                case RoundTrip.Cancelled: discarded++; break;
                case RoundTrip.Failed: failed++; break;
            }
        }

        var input = output + discarded + failed;
        if (input == 0)
        {
            return null;
        }

        var measurements = new MandatoryMeasurments(input, output, discarded, failed);
        if (measurements.OutputCount + measurements.FailedCount + measurements.DiscardedCount != measurements.InputCount)
        {
            throw new FailedException($"the report does not add up: {measurements}");
        }

        return new NapoleReport(
            new CommonDimentions(
                dimensions.ReporterComponentName,
                reporterSubComponentName,
                dimensions.ReporterNetworkName,
                window.From.ToUnixTimeMilliseconds(),
                window.To.ToUnixTimeMilliseconds(),
                insertedAt.ToUnixTimeMilliseconds(),
                dimensions.SrcCode,
                dimensions.SagCode,
                long.Parse(window.From.UtcDateTime.ToString("yyyyMMddHH", CultureInfo.InvariantCulture), CultureInfo.InvariantCulture)),
            measurements);
    }
}
