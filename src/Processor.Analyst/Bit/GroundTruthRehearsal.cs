using Microsoft.Extensions.Logging;
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
/// <b>Two scenarios, and the quiet one matters more.</b> A monitor that fires twice an hour and
/// cries wolf trains its operator to ignore it, so a false alarm costs more than a missed finding.
/// The quiet window runs first for that reason, and a prompt that invents a finding there fails
/// without the second scenario being paid for.
/// </para>
/// <para>
/// <b>Cost, stated plainly.</b> Each scenario is a full investigation against the real model: minutes
/// and real credit, paid once per prompt per process. Because <see cref="BitCache"/> dies with the
/// process, every replica pays this on every roll. A single rehearsal per scenario is also a single
/// stochastic draw — not corroborated the way the judge's ballots are, because corroboration here
/// would multiply an already expensive step. The mitigation is that a wrong rehearsal result is not
/// permanent: it lives only as long as the process, and the next roll re-runs it.
/// </para>
/// </summary>
internal sealed class GroundTruthRehearsal(
    IAnalystModel model,
    TimeProvider clock,
    ILoggerFactory loggerFactory,
    ILogger<GroundTruthRehearsal> logger)
{
    /// <summary>
    /// Budgets for a rehearsal, deliberately its own constants rather than the payload's. The
    /// evidence is seven small readings, so an investigation that cannot conclude inside this is
    /// telling us something about the prompt.
    /// </summary>
    private const int MaxIterations = 12;

    private const int MaxTokens = 1_500_000;
    private const int WallClockSeconds = 240;

    /// <summary>The window is arbitrary — the panels ignore it — but it must be well formed.</summary>
    private static readonly TimeSpan Window = TimeSpan.FromMinutes(15);

    internal async Task<IReadOnlyList<StageProblem>> RunAsync(string prompt, CancellationToken ct)
    {
        var quiet = await ConcludesAsync(prompt, RehearsalPanels.Quiet(), ct).ConfigureAwait(false);

        if (quiet is LoopOutcome.Finding invented)
        {
            return [new StageProblem("verify", "contradicting",
                "against a rehearsal window with every panel clean and every dead-letter queue at "
                + "zero, the prompt still produced a finding: "
                + Summarise(invented.Value)
                + " -- an operator who is woken by a quiet window learns to ignore the next alert")];
        }

        var fault = await ConcludesAsync(
            prompt, RehearsalPanels.HoldingDiscardedWork(), ct).ConfigureAwait(false);

        if (fault is LoopOutcome.NoFinding missed)
        {
            return [new StageProblem("verify", "contradicting",
                "against a rehearsal window holding 17 messages in a dead-letter queue, the prompt "
                + $"reported nothing: \"{missed.Reason}\" -- work this deployment threw away went "
                + "unreported, which is the one reading the instructions call always worth reporting")];
        }

        logger.LogInformation(
            "the payload prompt passed its ground-truth rehearsal: quiet window silent, planted "
            + "dead-letter depth reported");

        return [];
    }

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
            TargetWorkflowId: Guid.Empty,
            WindowMinutes: (int)Window.TotalMinutes,
            Prompt: prompt,
            PanelSet: panels.PanelIds,
            MaxIterations: MaxIterations,
            MaxTokens: MaxTokens,
            WallClockSeconds: WallClockSeconds);

        var to = clock.GetUtcNow();

        return await loop
            .RunAsync(ContractPrompt.Compose(prompt), config, new TimeRange(to - Window, to),
                PromptHash.Of(prompt), ct)
            .ConfigureAwait(false);
    }

    private static string Summarise(AnalystFinding finding)
        => $"verdict '{finding.Verdict}', citing "
         + (finding.Evidence.Count == 0
                ? "nothing"
                : string.Join(", ", finding.Evidence.Select(e => e.PanelId).Distinct()));
}
