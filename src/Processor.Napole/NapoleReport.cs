using System.Text.Json;

namespace Processor.Napole;

/// <summary>
/// One tick's report, the document the kafka-exporter writes.
/// <para>
/// <b>The names are an external contract and are kept verbatim, misspellings included</b>
/// (<c>commonDimentions</c>, <c>mandatoryMeasurments</c>, <c>timStampHour</c>): the camelCase of these
/// record properties is exactly those spellings, and <c>NapoleReportSchemaTests</c> pins them.
/// </para>
/// </summary>
public sealed record NapoleReport(CommonDimentions CommonDimentions, MandatoryMeasurments MandatoryMeasurments)
{
    // Not ProcessorConfig.SerializerOptions: that one is case-insensitive for reading only, and would
    // write CommonDimentions.
    private static readonly JsonSerializerOptions Options = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public byte[] Serialize() => JsonSerializer.SerializeToUtf8Bytes(this, Options);
}

/// <param name="ReportFromTime">the window's start, epoch milliseconds.</param>
/// <param name="ReportToTime">the window's end, epoch milliseconds.</param>
/// <param name="InsertionTime">when Napole built the report, epoch milliseconds.</param>
/// <param name="TimStampHour">the UTC hour of <paramref name="ReportFromTime"/> as <c>YYYYMMDDHH</c>.</param>
public sealed record CommonDimentions(
    string ReporterComponentName,
    string ReporterSubComponentName,
    string ReporterNetworkName,
    long ReportFromTime,
    long ReportToTime,
    long InsertionTime,
    string SrcCode,
    string SagCode,
    long TimStampHour);

/// <summary>
/// The tick's counts (reach spec §2.2-2.3). <paramref name="InputCount"/> counts executions; the other
/// three count step outcomes, with no deduplication, so they may add up to more than the input.
/// </summary>
/// <param name="InputCount">traced executions with a proven end: they reached <c>toStepId</c>, or failed or were cancelled on the way.</param>
/// <param name="OutputCount">Completed outcomes at <c>toStepId</c>, one per arrival.</param>
/// <param name="DiscardedCount">Cancelled outcomes: at <c>toStepId</c> if the execution reached it, otherwise at or after its first <c>fromStepId</c> outcome.</param>
/// <param name="FailedCount">Failed outcomes: at <c>toStepId</c> if the execution reached it, otherwise at or after its first <c>fromStepId</c> outcome.</param>
public sealed record MandatoryMeasurments(int InputCount, int OutputCount, int DiscardedCount, int FailedCount);
