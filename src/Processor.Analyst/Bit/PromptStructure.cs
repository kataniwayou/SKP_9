using System.Text.RegularExpressions;

namespace Processor.Analyst.Bit;

/// <summary>
/// The deterministic half of the gate: does the prompt define the five stages at all?
/// <para>
/// <b>This asks nothing of the model, and that is the point.</b> "Are the five stages present, in
/// order, with content" is a mechanical question, and mechanical questions must not be put to a
/// sampler — the judge answers them correctly most of the time, which is strictly worse than always.
/// Running this first also means a prompt with no stage structure at all is rejected for free and
/// identically every time, instead of costing five model calls to discover. The original
/// analyst-monitor prompt was exactly that prompt: 2.3k characters of panel semantics with no stage
/// headings anywhere.
/// </para>
/// <para>
/// <b>Scope is deliberately narrow.</b> Presence, order and substance are checkable without
/// judgement. Whether a stage is <i>reasonable</i> is not, and no amount of pattern matching will
/// make it so — that stays with <see cref="PreflightBit"/> and the model. Keeping this check to what
/// it can decide with certainty is what lets it be trusted absolutely; a heuristic here would just
/// be a second source of false alarms, wearing a deterministic disguise.
/// </para>
/// </summary>
internal static partial class PromptStructure
{
    /// <summary>The five stages, in the only order they may appear.</summary>
    private static readonly string[] Canonical = ["research", "validate", "plan", "execute", "verify"];

    /// <summary>Shortest body a stage may have before it counts as a heading with nothing under it.</summary>
    private const int MinimumStageBodyChars = 80;

    /// <summary>
    /// Finds stage headings, not mentions of the words.
    /// <para>
    /// <b>The distinction is load-bearing.</b> A prompt that says "the earlier stages observe, judge
    /// the evidence, plan, and gather" in its preamble mentions <c>plan</c> hundreds of characters
    /// before the research heading. Ordering judged on first word occurrence would reject that
    /// prompt, and the deployed one does exactly this. Requiring the literal word <c>stage</c>, an
    /// ordinal and a separator in front of the name keeps prose mentions out.
    /// </para>
    /// </summary>
    [GeneratedRegex(@"stage\s+\S{1,6}?\s*[-–—:.)]\s*(research|validate|plan|execute|verify)\b",
                    RegexOptions.IgnoreCase)]
    private static partial Regex StageHeading();

    /// <summary>
    /// Every structural fault in the prompt, or an empty list if it is well formed. An empty list is
    /// not a pass — it only means the model's judgement is now worth paying for.
    /// </summary>
    internal static IReadOnlyList<StageProblem> Check(string prompt)
    {
        ArgumentNullException.ThrowIfNull(prompt);

        var headings = StageHeading()
            .Matches(prompt)
            .Select(m => (Index: m.Index, Stage: m.Groups[1].Value.ToLowerInvariant()))
            .ToList();

        List<StageProblem> problems = [];

        // First occurrence of each stage heading, in the order they appear in the text.
        List<(int Index, string Stage)> first = [];
        foreach (var h in headings)
        {
            if (!first.Any(f => f.Stage == h.Stage))
            {
                first.Add(h);
            }
        }

        foreach (var stage in Canonical)
        {
            if (!first.Any(f => f.Stage == stage))
            {
                problems.Add(new StageProblem(
                    stage,
                    "missing",
                    $"the prompt defines no '{stage}' stage; expected a heading naming it, "
                    + $"such as \"STAGE n - {stage.ToUpperInvariant()}\""));
            }
        }

        // Order and substance are only meaningful once every stage is actually there.
        if (problems.Count > 0)
        {
            return problems;
        }

        var actual = first.Select(f => f.Stage).ToList();

        for (var i = 0; i < Canonical.Length; i++)
        {
            if (actual[i] != Canonical[i])
            {
                problems.Add(new StageProblem(
                    actual[i],
                    "contradicting",
                    $"the stages appear as {string.Join(" -> ", actual)}, but the investigation is "
                    + $"defined as {string.Join(" -> ", Canonical)}; a stage that runs before the one "
                    + "it depends on cannot be carried out in the order written"));
                break;
            }
        }

        for (var i = 0; i < first.Count; i++)
        {
            var start = first[i].Index;
            var end = i + 1 < first.Count ? first[i + 1].Index : prompt.Length;

            if (end - start < MinimumStageBodyChars)
            {
                problems.Add(new StageProblem(
                    first[i].Stage,
                    "malformed",
                    $"the '{first[i].Stage}' stage is a heading with {end - start} characters under "
                    + "it; there is nothing there for the agent to carry out"));
            }
        }

        return problems;
    }
}
