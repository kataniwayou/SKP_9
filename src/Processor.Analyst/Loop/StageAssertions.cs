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

        // The plan-vs-readings ordinal check above compares two self-reports: it passes for a model
        // that reads every panel first and ONLY THEN calls record_plan, because record_plan's ordinal
        // still precedes record_readings'. That is the exact rationalisation the plan stage exists to
        // prevent -- writing a "disconfirming" criterion for an answer already in hand -- and the only
        // thing that can catch it is the trace itself, which is ground truth for when each panel was
        // actually first read. A panel first read at or before the mark means its answer was already
        // known when the criterion naming it was written.
        //
        // The mark used here is per HYPOTHESIS, not per record_plan call: StageArtifacts anchors it to
        // the moment each hypothesis name first appeared in any plan, so a hypothesis carried forward
        // verbatim into a re-plan keeps its original mark (a re-plan is explicitly permitted, and
        // panels legitimately read between the two plans must not retroactively indict it), while a
        // hypothesis introduced for the first time in the re-plan is held to what had already been
        // read by then.
        foreach (var hypothesis in plan)
        {
            var name = hypothesis.GetProperty("hypothesis").GetString()!;
            var hypothesisMark = artifacts.HypothesisMarkOf(name);

            foreach (var panel in hypothesis.GetProperty("panelsToRead").EnumerateArray().Select(p => p.GetString()!))
            {
                var firstRead = trace.Entries
                    .Where(e => e.PanelId == panel)
                    .Select(e => e.Ordinal)
                    .DefaultIfEmpty(int.MaxValue)
                    .Min();

                if (firstRead <= hypothesisMark)
                {
                    problems.Add(
                        $"hypothesis '{name}' names {panel} as its disconfirming criterion, but {panel} "
                        + "was already read before this hypothesis was first planned -- the criterion "
                        + "was written after the answer was already known");
                }
            }
        }

        // A dictionary built with ToDictionary throws on a duplicate key, and the record_plan schema
        // has no way to express hypothesis-name uniqueness -- so a schema-valid reply can carry the
        // same hypothesis twice. That is a defective record, which is what a problem is for, not a
        // reason for Check itself to throw. TryAdd keeps the first declaration and flags the rest.
        //
        // Keyed by the WHITESPACE-NORMALISED name, because this dictionary is looked up from
        // record_verification and finding.ruledOut too, and the model is free to retype the same
        // hypothesis with a stray space each time it names it. The original, unnormalised name is
        // carried alongside for messages -- a problem should echo what is actually in record_plan's
        // payload, not a normalised form the operator will not find there.
        var criteria = new Dictionary<string, (string OriginalName, string[] PanelsToRead, string DisconfirmingCriterion)>(StringComparer.Ordinal);
        foreach (var hypothesis in plan)
        {
            var name = hypothesis.GetProperty("hypothesis").GetString()!;
            var panelsToRead = hypothesis.GetProperty("panelsToRead").EnumerateArray().Select(p => p.GetString()!).ToArray();
            var criterion = hypothesis.GetProperty("disconfirmingCriterion").GetString()!;

            if (!criteria.TryAdd(TextNormalization.Whitespace(name), (name, panelsToRead, criterion)))
            {
                problems.Add($"record_plan names the hypothesis '{name}' more than once");
            }
        }

        var verifiedHypotheses = new HashSet<string>(StringComparer.Ordinal);
        var survivedByHypothesis = new Dictionary<string, bool>(StringComparer.Ordinal);

        foreach (var verdict in artifacts.Get(ToolNames.RecordVerification).GetProperty("verdicts").EnumerateArray())
        {
            var hypothesis = verdict.GetProperty("hypothesis").GetString()!;
            var normalizedHypothesis = TextNormalization.Whitespace(hypothesis);
            verifiedHypotheses.Add(normalizedHypothesis);
            survivedByHypothesis.TryAdd(normalizedHypothesis, verdict.GetProperty("survived").GetBoolean());

            if (!criteria.TryGetValue(normalizedHypothesis, out var needed))
            {
                problems.Add($"verification names a hypothesis with no stated criterion: '{hypothesis}'");
                continue;
            }

            foreach (var panel in needed.PanelsToRead.Where(p => !read.Contains(p)))
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

        // The reverse direction: a hypothesis the plan proposed but verification never judges could
        // otherwise be claimed as ruled out below with nothing behind that claim at all. Message uses
        // record_plan's own original spelling of the name, not the normalised dictionary key.
        foreach (var (normalizedHypothesis, declared) in criteria)
        {
            if (!verifiedHypotheses.Contains(normalizedHypothesis))
            {
                problems.Add($"record_plan proposes '{declared.OriginalName}' but record_verification never judges it");
            }
        }

        // record_plan and record_verification are checked above, but neither is ever exported --
        // finding.ruledOut is the only pre-commitment artifact that reaches the operator, and until
        // now it was never cross-checked against the record that is supposed to back it.
        foreach (var ruledOut in finding.GetProperty("ruledOut").EnumerateArray())
        {
            var hypothesis = ruledOut.GetProperty("hypothesis").GetString()!;
            var normalizedHypothesis = TextNormalization.Whitespace(hypothesis);
            var criterion = ruledOut.GetProperty("disconfirmingCriterion").GetString()!;

            if (!criteria.TryGetValue(normalizedHypothesis, out var declared))
            {
                problems.Add($"the finding rules out '{hypothesis}', which record_plan never proposed");
            }
            else if (!string.Equals(
                         TextNormalization.Whitespace(declared.DisconfirmingCriterion),
                         TextNormalization.Whitespace(criterion),
                         StringComparison.Ordinal))
            {
                // Trimmed and collapsed, not case-folded: a trailing period or a doubled space is a
                // formatting slip, not a criterion swap, and should not read as one. Anything past
                // that -- a genuinely different word -- still fails, deliberately.
                problems.Add(
                    $"the finding's ruledOut criterion for '{hypothesis}' does not match the one "
                    + "record_plan stated -- copy it verbatim");
            }

            if (!survivedByHypothesis.TryGetValue(normalizedHypothesis, out var survived) || survived)
            {
                problems.Add(
                    $"the finding rules out '{hypothesis}', but record_verification has no "
                    + "surviving=false verdict for it");
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
