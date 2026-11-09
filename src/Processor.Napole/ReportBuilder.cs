using System.Globalization;

namespace Processor.Napole;

public static class ReportBuilder
{
    /// <summary>
    /// The report for one window, or null when no traced execution has a proven end -- the tick then
    /// sends nothing (sections spec §6).
    /// <para>
    /// <b>The counters count step outcomes; they may exceed the input</b> (reach spec §2.3, decided).
    /// The input counts executions with a proven end. The counters add each one's outcomes at
    /// <c>toStepId</c>, or on the way, with no deduplication: two branches reaching <c>toStepId</c> add
    /// two. The 2026-11-08 identity (output + failed + discarded = input) is replaced, so it is no
    /// longer checked.
    /// </para>
    /// </summary>
    public static NapoleReport? Build(
        ReportWindow window,
        IEnumerable<Contribution> contributions,
        ReportDimensions dimensions,
        DateTimeOffset insertedAt)
    {
        ArgumentNullException.ThrowIfNull(contributions);
        ArgumentNullException.ThrowIfNull(dimensions);

        int input = 0, output = 0, discarded = 0, failed = 0;
        foreach (var c in contributions)
        {
            input += c.Input;
            output += c.Output;
            discarded += c.Discarded;
            failed += c.Failed;
        }

        if (input == 0)
        {
            return null;
        }

        var measurements = new MandatoryMeasurments(input, output, discarded, failed);

        return new NapoleReport(
            new CommonDimentions(
                dimensions.ReporterComponentName,
                dimensions.ReporterSubComponentName,
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
