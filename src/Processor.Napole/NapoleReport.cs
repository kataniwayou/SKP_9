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

/// <summary>Per execution, terminated ones only: <c>OutputCount + FailedCount + DiscardedCount == InputCount</c>.</summary>
/// <param name="OutputCount">Complete.</param>
/// <param name="DiscardedCount">Cancelled during the round trip.</param>
/// <param name="FailedCount">Failed.</param>
public sealed record MandatoryMeasurments(int InputCount, int OutputCount, int DiscardedCount, int FailedCount);
