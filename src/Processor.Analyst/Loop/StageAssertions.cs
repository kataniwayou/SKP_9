using System.Text.Json;
using Processor.Analyst.Tools;

namespace Processor.Analyst.Loop;

/// <summary>
/// Cross-reference checks over one finished investigation.
/// <para>
/// Every check here is a real way a plausible-looking investigation goes wrong, and every one is
/// decidable from the artifacts alone. Deep semantic contradiction inside prose is out of reach and
/// this deliberately does not pretend otherwise — a narrative that subtly argues against itself will
/// pass, and the preflight BIT plus the scored-window replay are what address that.
/// </para>
/// </summary>
internal static class StageAssertions
{
    private static readonly string[] RequiredStages =
    [
        ToolNames.RecordResearch,
        ToolNames.RecordValidation,
        ToolNames.RecordPlan,
        ToolNames.RecordReadings,
        ToolNames.RecordVerification,
    ];

    internal static IReadOnlyList<string> Check(
        StageArtifacts artifacts, InvestigationTrace trace, JsonElement finding)
    {
        ArgumentNullException.ThrowIfNull(artifacts);
        ArgumentNullException.ThrowIfNull(trace);

        var problems = new List<string>();

        foreach (var stage in RequiredStages)
        {
            if (!artifacts.Has(stage))
            {
                problems.Add($"stage {stage} was never recorded");
            }
        }

        if (problems.Count > 0)
        {
            // Everything below reads the artifacts. With one missing there is nothing coherent left
            // to say, and a cascade of derived complaints would bury the real one.
            return problems;
        }

        if (artifacts.OrdinalOf(ToolNames.RecordPlan) > artifacts.OrdinalOf(ToolNames.RecordReadings))
        {
            problems.Add(
                "record_plan was recorded after record_readings; the disconfirming criteria must be "
                + "stated before the evidence that bears on them is gathered");
        }

        var read = trace.PanelsRead;
        var plan = artifacts.Get(ToolNames.RecordPlan).GetProperty("hypotheses").EnumerateArray().ToArray();
        var criteria = plan.ToDictionary(
            h => h.GetProperty("hypothesis").GetString()!,
            h => h.GetProperty("panelsToRead").EnumerateArray().Select(p => p.GetString()!).ToArray(),
            StringComparer.Ordinal);

        foreach (var verdict in artifacts.Get(ToolNames.RecordVerification).GetProperty("verdicts").EnumerateArray())
        {
            var hypothesis = verdict.GetProperty("hypothesis").GetString()!;

            if (!criteria.TryGetValue(hypothesis, out var needed))
            {
                problems.Add($"verification names a hypothesis with no stated criterion: '{hypothesis}'");
                continue;
            }

            foreach (var panel in needed.Where(p => !read.Contains(p)))
            {
                problems.Add(
                    $"hypothesis '{hypothesis}' was judged without reading {panel}, which its own "
                    + "disconfirming criterion named");
            }

            foreach (var cited in verdict.GetProperty("citedPanels").EnumerateArray()
                         .Select(p => p.GetString()!).Where(p => !read.Contains(p)))
            {
                problems.Add($"verification for '{hypothesis}' cites {cited}, which was never read");
            }
        }

        foreach (var evidence in finding.GetProperty("evidence").EnumerateArray())
        {
            var panelId = evidence.GetProperty("panelId").GetString()!;

            if (!read.Contains(panelId))
            {
                problems.Add($"the finding cites evidence from {panelId}, which the trace shows was never read");
            }
        }

        return problems;
    }
}
