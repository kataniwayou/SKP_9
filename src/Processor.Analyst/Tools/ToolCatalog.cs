using System.Text.Json;
using Processor.Analyst.Model;
using Processor.Analyst.Panels;

namespace Processor.Analyst.Tools;

/// <summary>
/// The tool block handed to the model. Fixed in size: one parameterized <c>read_panel</c> rather than
/// one tool per panel, because the tool block is the cache prefix and a growing panel set would
/// inflate every request.
/// </summary>
internal static class ToolCatalog
{
    internal static IReadOnlyList<ToolSpec> Build(IReadOnlyList<PanelDescriptor> panels)
    {
        ArgumentNullException.ThrowIfNull(panels);

        var ids = JsonSerializer.Serialize(panels.Select(p => p.PanelId));

        return
        [
            new ToolSpec(ToolNames.ListPanels,
                "List the panels available for this investigation, with the layer each belongs to.",
                Closed("{}", required: "[]")),

            new ToolSpec(ToolNames.ReadPanel,
                "Read one panel over the analysis window. The result carries trust flags: a series "
                + "that was absent, a window only partly covered, or a 'no data' that could not be "
                + "told apart from 'no problem'. Treat those as facts about the evidence, not about "
                + "the system.",
                $$"""
                {"type":"object",
                 "properties":{"panelId":{"type":"string","enum":
                   {{ids}}
                 } },
                 "required":["panelId"],
                 "additionalProperties":false}
                """),

            new ToolSpec(ToolNames.RecordResearch,
                "Record what the window looks like before forming any hypothesis.",
                SchemaFor(ToolNames.RecordResearch)),

            new ToolSpec(ToolNames.RecordValidation,
                "Record whether the evidence gathered so far can be believed, and why.",
                SchemaFor(ToolNames.RecordValidation)),

            new ToolSpec(ToolNames.RecordPlan,
                "Record each hypothesis together with the evidence that would KILL it. State the "
                + "disconfirming criterion before reading anything that bears on it.",
                SchemaFor(ToolNames.RecordPlan)),

            new ToolSpec(ToolNames.RecordReadings,
                "Record the readings gathered against the plan.",
                SchemaFor(ToolNames.RecordReadings)),

            new ToolSpec(ToolNames.RecordVerification,
                "Record, per hypothesis, whether it survived its own stated criterion.",
                SchemaFor(ToolNames.RecordVerification)),

            new ToolSpec(ToolNames.SubmitFinding,
                "End the investigation with a finding. Every insight is an inference that correlates "
                + "at least two panels you read into a cause, a consequence or a contradiction no "
                + "single panel shows. Never restate a reading as an insight, and never report what "
                + "is healthy: the readings belong in evidence.",
                SchemaFor(ToolNames.SubmitFinding)),

            new ToolSpec(ToolNames.ReportNoFinding,
                "End the investigation with nothing to report. The analysis ran and reached no "
                + "insight. This is the honest ending when no hypothesis survived, or when what "
                + "survived cannot be correlated into an insight.",
                SchemaFor(ToolNames.ReportNoFinding)),
        ];
    }

    /// <summary>The input schema for one tool, by name. Used by the loop to validate every input client-side.</summary>
    internal static string SchemaFor(string toolName) => toolName switch
    {
        ToolNames.ListPanels => Closed("{}", "[]"),

        ToolNames.RecordResearch => """
            {"type":"object",
             "properties":{"observations":{"type":"array","minItems":1,"items":{"type":"string","minLength":1}}},
             "required":["observations"],
             "additionalProperties":false}
            """,

        ToolNames.RecordValidation => """
            {"type":"object",
             "properties":{
               "analysable":{"type":"boolean"},
               "concerns":{"type":"array","items":{"type":"string","minLength":1}},
               "reason":{"type":"string","minLength":1}},
             "required":["analysable","concerns","reason"],
             "additionalProperties":false}
            """,

        ToolNames.RecordPlan => """
            {"type":"object",
             "properties":{"hypotheses":{"type":"array","minItems":1,"items":{
               "type":"object",
               "properties":{
                 "hypothesis":{"type":"string","minLength":1},
                 "disconfirmingCriterion":{"type":"string","minLength":1},
                 "panelsToRead":{"type":"array","minItems":1,"items":{"type":"string","minLength":1}}},
               "required":["hypothesis","disconfirmingCriterion","panelsToRead"],
               "additionalProperties":false}}},
             "required":["hypotheses"],
             "additionalProperties":false}
            """,

        ToolNames.RecordReadings => """
            {"type":"object",
             "properties":{"readings":{"type":"array","minItems":1,"items":{
               "type":"object",
               "properties":{
                 "panelId":{"type":"string","minLength":1},
                 "summary":{"type":"string","minLength":1},
                 "trusted":{"type":"boolean"}},
               "required":["panelId","summary","trusted"],
               "additionalProperties":false}}},
             "required":["readings"],
             "additionalProperties":false}
            """,

        ToolNames.RecordVerification => """
            {"type":"object",
             "properties":{"verdicts":{"type":"array","minItems":1,"items":{
               "type":"object",
               "properties":{
                 "hypothesis":{"type":"string","minLength":1},
                 "survived":{"type":"boolean"},
                 "whatWasSeen":{"type":"string","minLength":1},
                 "citedPanels":{"type":"array","minItems":1,"items":{"type":"string","minLength":1}}},
               "required":["hypothesis","survived","whatWasSeen","citedPanels"],
               "additionalProperties":false}}},
             "required":["verdicts"],
             "additionalProperties":false}
            """,

        ToolNames.SubmitFinding => """
            {"type":"object",
             "properties":{
               "verdict":{"type":"string","enum":["Drifting","Notable"]},
               "insights":{"type":"array","minItems":1,"items":{
                 "type":"object",
                 "properties":{
                   "claim":{"type":"string","minLength":1},
                   "why":{"type":"string","minLength":1},
                   "panels":{"type":"array","minItems":2,"uniqueItems":true,"items":{"type":"string","minLength":1}}},
                 "required":["claim","why","panels"],
                 "additionalProperties":false}},
               "samplesExamined":{"type":"integer","minimum":0},
               "evidence":{"type":"array","minItems":1,"items":{
                 "type":"object",
                 "properties":{
                   "panelId":{"type":"string","minLength":1},
                   "layer":{"type":"string","minLength":1},
                   "label":{"type":"string","minLength":1},
                   "value":{"type":"string"}},
                 "required":["panelId","layer","label","value"],
                 "additionalProperties":false}},
               "ruledOut":{"type":"array","items":{
                 "type":"object",
                 "properties":{
                   "hypothesis":{"type":"string","minLength":1},
                   "disconfirmingCriterion":{"type":"string","minLength":1},
                   "whatWasSeen":{"type":"string","minLength":1}},
                 "required":["hypothesis","disconfirmingCriterion","whatWasSeen"],
                 "additionalProperties":false}}},
             "required":["verdict","insights","samplesExamined","evidence","ruledOut"],
             "additionalProperties":false}
            """,

        ToolNames.ReportNoFinding => """
            {"type":"object",
             "properties":{"reason":{"type":"string","minLength":1}},
             "required":["reason"],
             "additionalProperties":false}
            """,

        _ => throw new ArgumentOutOfRangeException(nameof(toolName), toolName, "no schema for this tool"),
    };

    private static string Closed(string properties, string required)
        => $$"""{"type":"object","properties":{{properties}},"required":{{required}},"additionalProperties":false}""";
}
