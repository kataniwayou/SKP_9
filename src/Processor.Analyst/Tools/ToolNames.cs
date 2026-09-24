namespace Processor.Analyst.Tools;

/// <summary>
/// Every tool the agent has, by name. Compiled constants, because the payload prompt must not be able
/// to rename or remove one — that would break the typed exit and turn every dispatch into a failed
/// step with no obvious cause.
/// </summary>
internal static class ToolNames
{
    internal const string ListPanels = "list_panels";
    internal const string ReadPanel = "read_panel";

    internal const string RecordResearch = "record_research";
    internal const string RecordValidation = "record_validation";
    internal const string RecordPlan = "record_plan";
    internal const string RecordReadings = "record_readings";
    internal const string RecordVerification = "record_verification";

    internal const string SubmitFinding = "submit_finding";
    internal const string ReportNoFinding = "report_no_finding";

    /// <summary>
    /// The only two ways an investigation may end.
    /// <para>
    /// They map one-to-one onto step dispositions: <see cref="SubmitFinding"/> → Completed → the
    /// exporter runs; <see cref="ReportNoFinding"/> → Cancelled → silence, which is the all-clear.
    /// Every other ending — budget exhausted, malformed input, an assertion violated — is Failed.
    /// </para>
    /// </summary>
    internal static readonly IReadOnlySet<string> Terminal =
        new HashSet<string> { SubmitFinding, ReportNoFinding };
}
