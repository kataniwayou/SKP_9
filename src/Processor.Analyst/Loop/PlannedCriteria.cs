using System.Text.Json;
using System.Text.Json.Nodes;
using Processor.Analyst.Tools;

namespace Processor.Analyst.Loop;

/// <summary>
/// Puts each ruled-out hypothesis's disconfirming criterion back to the words record_plan stated,
/// before <see cref="StageAssertions"/> checks the finding.
/// <para>
/// <b>The point of the check survives; only the clerical half moves to code.</b>
/// <see cref="StageAssertions"/> compares a ruledOut criterion with the planned one so that a finding
/// can never publish a criterion written after the evidence was in. Making the model retype it to the
/// character enforced that, and also failed whole dispatches over a reworded sentence whose
/// conclusion was sound (2 of 5 replay runs of one scenario). Filling it from the plan publishes
/// exactly the pre-committed criterion every time, which is the property the check guards, and no
/// longer depends on transcription.
/// </para>
/// <para>
/// <b>Only a hypothesis the plan names is filled.</b> A ruledOut entry whose name the plan never
/// stated keeps the model's text, so the "never proposed" check still fires on it. Names match the
/// way <see cref="StageAssertions"/> matches them: whitespace collapsed, case kept.
/// </para>
/// </summary>
internal static class PlannedCriteria
{
    internal static JsonElement Apply(StageArtifacts artifacts, JsonElement finding)
    {
        if (!artifacts.Has(ToolNames.RecordPlan)
            || !finding.TryGetProperty("ruledOut", out var ruledOut)
            || ruledOut.ValueKind != JsonValueKind.Array)
        {
            return finding;
        }

        var planned = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var hypothesis in artifacts.Get(ToolNames.RecordPlan).GetProperty("hypotheses").EnumerateArray())
        {
            // First occurrence wins; a duplicate is StageAssertions' problem to report, not this one's.
            planned.TryAdd(
                TextNormalization.Whitespace(hypothesis.GetProperty("hypothesis").GetString()!),
                hypothesis.GetProperty("disconfirmingCriterion").GetString()!);
        }

        var node = JsonNode.Parse(finding.GetRawText())!;
        foreach (var entry in node["ruledOut"]!.AsArray())
        {
            if (entry?["hypothesis"]?.GetValue<string>() is { } name
                && planned.TryGetValue(TextNormalization.Whitespace(name), out var criterion))
            {
                entry["disconfirmingCriterion"] = criterion;
            }
        }

        using var document = JsonDocument.Parse(node.ToJsonString());
        return document.RootElement.Clone();
    }
}
