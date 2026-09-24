using Processor.Analyst.Model;

namespace BaseApi.Tests.Analyst;

/// <summary>
/// The five-stage script a well-behaved agent follows before submitting, shared between
/// <see cref="InvestigationLoopTests"/> (which drives the loop directly) and
/// <see cref="AnalystProcessorTests"/> (which drives the processor end to end). One definition
/// rather than two keeps the shape of a compliant run in one place — the exact place
/// <c>StageAssertions</c> and the record_* schemas would otherwise be duplicated against.
/// </summary>
internal static class AnalystScript
{
    /// <summary>The five stage calls, one reply each, ending with the one read_panel the default plan names.</summary>
    internal static ModelReply[] Stages(string panelId = "queue-depth") =>
    [
        ModelReply.Of(ScriptedModel.Call("record_research", new { observations = new[] { "arrival mean rose" } })),
        ModelReply.Of(ScriptedModel.Call("record_validation", new { analysable = true, concerns = Array.Empty<string>(), reason = "series present" })),
        ModelReply.Of(ScriptedModel.Call("record_plan", new { hypotheses = new[] { new { hypothesis = "broker slow", disconfirmingCriterion = "queue depth over 100", panelsToRead = new[] { panelId } } } })),
        ModelReply.Of(ScriptedModel.Call(ToolNamesForTest.ReadPanel, new { panelId })),
        ModelReply.Of(ScriptedModel.Call("record_readings", new { readings = new[] { new { panelId, summary = "max 4", trusted = true } } })),
        ModelReply.Of(ScriptedModel.Call("record_verification", new { verdicts = new[] { new { hypothesis = "broker slow", survived = false, whatWasSeen = "max 4", citedPanels = new[] { panelId } } } })),
    ];

    /// <summary>
    /// F1: the same five stage calls as <see cref="Stages"/>, but WITHOUT the trailing
    /// <c>read_panel</c> call -- fabricated stages with no observation behind them. The record_*
    /// schemas require only non-empty strings, so a model can call all five and claim a panel was
    /// read (in <c>record_readings</c>) and cited (in <c>record_verification</c>) when
    /// <c>InvestigationTrace</c> shows it never actually called <c>read_panel</c> at all. Used to
    /// prove <c>report_no_finding</c> cannot buy silence from an investigation that never looked.
    /// </summary>
    internal static ModelReply[] StagesWithoutReadingAnyPanel(string panelId = "queue-depth") =>
    [
        ModelReply.Of(ScriptedModel.Call("record_research", new { observations = new[] { "arrival mean rose" } })),
        ModelReply.Of(ScriptedModel.Call("record_validation", new { analysable = true, concerns = Array.Empty<string>(), reason = "series present" })),
        ModelReply.Of(ScriptedModel.Call("record_plan", new { hypotheses = new[] { new { hypothesis = "broker slow", disconfirmingCriterion = "queue depth over 100", panelsToRead = new[] { panelId } } } })),
        ModelReply.Of(ScriptedModel.Call("record_readings", new { readings = new[] { new { panelId, summary = "max 4", trusted = true } } })),
        ModelReply.Of(ScriptedModel.Call("record_verification", new { verdicts = new[] { new { hypothesis = "broker slow", survived = false, whatWasSeen = "max 4", citedPanels = new[] { panelId } } } })),
    ];

    /// <summary>A valid submit_finding call, citing the given panel as its evidence, as a raw tool call.</summary>
    internal static ModelToolCall SubmitFinding(string panelId = "queue-depth") => ScriptedModel.Call(ToolNamesForTest.SubmitFinding, new
    {
        verdict = "Drifting",
        narrative = "arrival mean rose",
        samplesExamined = 91,
        evidence = new[] { new { panelId, layer = "ops", label = "mean", value = "180ms" } },
        ruledOut = new[]
        {
            new { hypothesis = "broker slow", disconfirmingCriterion = "queue depth over 100", whatWasSeen = "max 4" },
        },
    });

    /// <summary>The same call, wrapped as the reply that carries it.</summary>
    internal static ModelReply Submit(string panelId = "queue-depth") => ModelReply.Of(SubmitFinding(panelId));
}

/// <summary>Mirrors ToolNames, which is internal to the processor and reached through InternalsVisibleTo.</summary>
internal static class ToolNamesForTest
{
    internal const string ReadPanel = "read_panel";
    internal const string SubmitFinding = "submit_finding";
    internal const string ReportNoFinding = "report_no_finding";
}
