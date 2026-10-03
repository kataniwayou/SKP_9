using Microsoft.Extensions.Logging;
using Processor.Analyst.Graph;
using Processor.Analyst.Loop;
using Processor.Analyst.Model;
using Processor.Analyst.Panels;

namespace Processor.Analyst.Bit;

/// <summary>
/// The third part of the gate: does the prompt reach the RIGHT conclusion about data whose content
/// is already known.
/// <para>
/// <b>Neither earlier part can see this class of fault.</b> <see cref="PromptStructure"/> decides
/// whether the five stages exist; the judge decides whether they describe a workable method, graded
/// against a hypothetical it never reads a panel for. A prompt can pass both, point at exactly the
/// right panels — the agent physically cannot read any others, since <c>ToolCatalog</c> pins
/// <c>read_panel</c> to a closed enum — and still conclude wrongly. Only ground truth catches that.
/// </para>
/// <para>
/// <b>The graph rides along, as it does on a live dispatch.</b> A v12 prompt derives what every panel
/// should show from the running graph before reading any of them, so each rehearsal briefs the loop
/// with <see cref="RehearsalGraph"/> exactly as <c>AnalystProcessor</c> briefs it with the target's.
/// </para>
/// <para>
/// <b>Three scenarios, and the quiet one matters more.</b> A monitor that fires twice an hour and
/// cries wolf trains its operator to ignore it, so a false alarm costs more than a missed finding.
/// The quiet window runs first for that reason, and a prompt that invents a finding there fails
/// without the second scenario being paid for.
/// </para>
/// <para>
/// <b>Cost, stated plainly.</b> Each scenario is a full investigation against the real model: minutes
/// and real credit, paid once per prompt and model: <see cref="BitCache"/> shares the verdict with
/// every replica. A single rehearsal per scenario is also a single stochastic draw — not corroborated
/// the way the judge's ballots are, because corroboration here would multiply an already expensive
/// step. A wrong rehearsal result is therefore shared too, and a rolling deploy does not clear it;
/// it clears when the prompt changes, the model, effort or image changes, or every replica is gone for one
/// liveness TTL.
/// </para>
/// </summary>
internal sealed class GroundTruthRehearsal(
    IAnalystModel model,
    TimeProvider clock,
    ILoggerFactory loggerFactory,
    ILogger<GroundTruthRehearsal> logger)
{
    /// <summary>
    /// Budgets for a rehearsal: its own constants, compiled like the rest of the gate, set equal to
    /// what the analyst-monitor step payload grants a live dispatch. A rehearsal stricter than
    /// production fails prompts that work in production: at 240 seconds a v12 quiet rehearsal was
    /// cancelled mid-call, while live v12 investigations took 125 and 206 seconds of a 600-second
    /// budget, and the deadline cancels the model call in flight rather than ending between turns.
    /// At 600 seconds the v14 loss rehearsal was cancelled the same way on two dev fires in a row,
    /// with single Kimi replies of 142 to 263 seconds, so both this and the payload are 1200.
    /// </summary>
    private const int MaxIterations = 12;

    private const int MaxTokens = 1_500_000;
    private const int WallClockSeconds = 1200;

    /// <summary>15 minutes, so the fixture graph's once-a-minute cron schedules the 15 fires the panels show.</summary>
    private static readonly TimeSpan Window = TimeSpan.FromMinutes(15);

    internal async Task<IReadOnlyList<StageProblem>> RunAsync(string prompt, CancellationToken ct)
    {
        var quiet = await ConcludesAsync(prompt, RehearsalPanels.Quiet(), ct).ConfigureAwait(false);

        if (quiet is LoopOutcome.Finding invented)
        {
            return [new StageProblem("verify", "contradicting",
                "against a quiet rehearsal window -- every count one the running graph's routing "
                + "explains (6 items rejected for their own extension, 5 empty polls cancelled with no "
                + "terminal record, terminal 34 at persist-file and 6 at record-outcome, and the 15% "
                + "rejection rate within the declared expectation), every "
                + "dead-letter queue at zero, no refusal -- the prompt still produced a finding: "
                + Summarise(invented.Value)
                + " -- an operator who is woken by a quiet window learns to ignore the next alert")];
        }

        var fault = await ConcludesAsync(
            prompt, RehearsalPanels.HoldingDiscardedWork(), ct).ConfigureAwait(false);

        if (fault is LoopOutcome.NoFinding missed)
        {
            return [new StageProblem("verify", "contradicting",
                "against a rehearsal window in which a dead-letter queue grew from 0 to 17 while 17 "
                + "parked refusals landed, the step-outcomes totals fell 17 short of the routing's "
                + "prediction and terminal at persist-file read 17 against 34 good items, the prompt "
                + $"reported nothing: \"{missed.Reason}\" -- work this deployment threw away during the "
                + "window went unreported, though four readings agree on the loss")];
        }

        if (Unclassified(fault, "system") is { } lossProblem)
        {
            return [lossProblem];
        }

        var badInput = await ConcludesAsync(
            prompt, RehearsalPanels.RejectingBadInput(), ct).ConfigureAwait(false);

        if (badInput is LoopOutcome.NoFinding ignored)
        {
            return [new StageProblem("verify", "contradicting",
                "against a rehearsal window in which 15% of items failed validation for a cause in the item "
                + "itself, steadily since the workflow's start, with no declared expectation, the prompt "
                + $"reported nothing: \"{ignored.Reason}\" -- undeclared bad input is a deterministic data "
                + "problem the operator must hear about")];
        }

        if (Unclassified(badInput, "data") is { } dataProblem)
        {
            return [dataProblem];
        }

        logger.LogInformation(
            "the payload prompt passed its ground-truth rehearsal: quiet window silent, planted "
            + "loss and undeclared bad input reported and classified");

        return [];
    }

    /// <summary>
    /// A finding in a scenario with a known cause must say what the operator needs to hear: a
    /// deterministic problem in the right domain. Anything else is a report that names the wrong
    /// kind of thing, however alarming it sounds. The problem names what the finding did classify,
    /// because a failed dispatch publishes nothing and this verdict is the only record of it.
    /// </summary>
    private static StageProblem? Unclassified(LoopOutcome outcome, string domain)
        => outcome is LoopOutcome.Finding f
           && f.Value.Insights.Any(i => i.Classification == "deterministic" && i.Domain == domain)
            ? null
            : new StageProblem("verify", "contradicting",
                $"the rehearsal window holds a deterministic {domain} problem, and the prompt's finding "
                + $"carries no insight classified deterministic in the {domain} domain -- the operator "
                + "would be told the wrong kind of thing; it classified "
                + (outcome is LoopOutcome.Finding found ? Classified(found.Value) : "no finding"));

    private static string Classified(AnalystFinding finding)
        => finding.Insights.Count == 0
            ? "no insights"
            : string.Join("; ", finding.Insights.Select(i => $"{i.Classification}/{i.Domain}: {i.Claim}"));

    /// <summary>
    /// One rehearsal. <see cref="AnalysisImpossibleException"/> is deliberately not caught: a
    /// rehearsal that could not run says nothing about the prompt, and must surface as
    /// "the analysis could not run" rather than be recorded as a verdict against it.
    /// </summary>
    private async Task<LoopOutcome> ConcludesAsync(
        string prompt, RehearsalPanels panels, CancellationToken ct)
    {
        var loop = new InvestigationLoop(
            model, panels, clock, loggerFactory.CreateLogger<InvestigationLoop>());

        var config = new AnalystConfig(
            TargetWorkflowId: RehearsalGraph.WorkflowId,
            WindowMinutes: (int)Window.TotalMinutes,
            Prompt: prompt,
            PanelSet: panels.PanelIds,
            MaxIterations: MaxIterations,
            MaxTokens: MaxTokens,
            WallClockSeconds: WallClockSeconds);

        var to = clock.GetUtcNow();

        return await loop
            .RunAsync(ContractPrompt.Compose(prompt), config, new TimeRange(to - Window, to),
                PromptHash.Of(prompt), ct,
                RehearsalGraph.Briefing + "\n\n"
                    + RunContextRenderer.Render(RehearsalGraph.RunFor(to), new TimeRange(to - Window, to), panels.Expectations),
                RehearsalGraph.RunFor(to).HistoryLimit)
            .ConfigureAwait(false);
    }

    private static string Summarise(AnalystFinding finding)
        => $"verdict '{finding.Verdict}', citing "
         + (finding.Evidence.Count == 0
                ? "nothing"
                : string.Join(", ", finding.Evidence.Select(e => e.PanelId).Distinct()));
}
