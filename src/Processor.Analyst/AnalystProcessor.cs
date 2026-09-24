using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;
using Processor.Analyst.Bit;
using Processor.Analyst.Loop;
using Processor.Analyst.Panels;

namespace Processor.Analyst;

/// <summary>
/// One dispatch: check the prompt is fit, run the investigation, and end in exactly one disposition.
/// <para>
/// <b>The disposition describes whether the analysis ran — never what it concluded.</b> An analysis
/// that finds the system on fire is a successful analysis. A verdict is never a failure, good or bad.
/// </para>
/// </summary>
internal sealed class AnalystProcessor(
    PreflightBit bit,
    InvestigationLoop loop,
    ILogger<AnalystProcessor> logger)
    : BaseProcessor<AnalystConfig>
{
    /// <summary>The longest window any panel source here can honestly answer.</summary>
    private static readonly TimeSpan MaxWindow = TimeSpan.FromDays(30);

    protected override async Task ProcessAsync(
        byte[] data, AnalystConfig? config, Guid executionId, CancellationToken ct)
    {
        if (config is null)
        {
            // FailedException carries "business reason" in its doc comment; here it is the opposite,
            // an infra/config fault. It is simply how StepResult.Failed is reported.
            throw new FailedException("no step payload; the Analyst cannot run without one");
        }

        var finding = await AnalyseAsync(config, ct).ConfigureAwait(false);

        await SendToPostAsync(AnalystFinding.Serialize(finding), executionId, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The whole dispatch minus the send, so it can be tested without a <c>DispatchState</c>.
    /// Returns a finding, throws <c>CancelledException</c> for a quiet run, <c>FailedException</c>
    /// for everything else.
    /// </summary>
    internal async Task<AnalystFinding> AnalyseAsync(AnalystConfig config, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(config);

        // Checks the schema cannot express, before anything is spent.
        if (string.IsNullOrWhiteSpace(config.Prompt))
        {
            throw new FailedException("the payload prompt is empty after trimming");
        }

        var window = TimeSpan.FromMinutes(config.WindowMinutes);
        if (window > MaxWindow)
        {
            throw new FailedException(
                $"window of {window.TotalDays:F0} days exceeds what the panels retain ({MaxWindow.TotalDays:F0} days)");
        }

        LoopOutcome outcome;
        try
        {
            // The BIT's own model call and the loop's are the same class of risk: either one can end
            // in "the analysis could not run" rather than a verdict about the prompt or the system.
            // Both live inside this one try so both AnalysisImpossibleException sources map to the
            // same FailedException, rather than the BIT's escaping uncaught into the framework's
            // generic fault branch.
            var verdict = await bit.CheckAsync(config.Prompt, ct).ConfigureAwait(false);
            if (!verdict.Fit)
            {
                var summary = string.Join("; ", verdict.Problems.Select(p => $"{p.Stage}: {p.Kind}"));
                logger.LogWarning("the payload prompt failed its preflight check: {Problems}", summary);

                // NOT Cancelled. An agent that failed its fitness exam has analysed nothing, and
                // silence is the all-clear.
                throw new FailedException($"the payload prompt is unfit: {summary}");
            }

            var to = DateTimeOffset.UtcNow;
            var range = new TimeRange(to - window, to);

            outcome = await loop
                .RunAsync(ContractPrompt.Compose(config.Prompt), config, range, PromptHash.Of(config.Prompt), ct)
                .ConfigureAwait(false);
        }
        catch (AnalysisImpossibleException ex)
        {
            throw new FailedException(ex.Message);
        }
        // The worst failure this design can have is a monitor that reports all-clear because it
        // broke. Cancelled is reserved for a run that reached a terminal tool and found nothing —
        // NOT for a run that never got there — so an OperationCanceledException from a library call
        // (an HTTP timeout is the common shape) must be mapped to FailedException deliberately rather
        // than left to the framework's generic fault branch, which logs it as a code bug.
        //
        // The filter matters: `when (!ct.IsCancellationRequested)`. ProcessDispatchHandler's own
        // catch (FailedException) sits ABOVE its filtered general catch -- so if `ct` is ever the one
        // that got cancelled (the real consumer passes CancellationToken.None today, confirmed at
        // GatedQueueConsumer.cs:368, but this method must not assume that forever), converting a
        // genuine shutdown into FailedException here would acknowledge the delivery with a fabricated
        // outcome and lose the message. Letting THAT case escape unfiltered creates no hazard this
        // design is guarding against: an escaping OperationCanceledException parks the delivery with
        // no StepOutcome sent at all, so nothing downstream ever reads Cancelled. The filter is what
        // keeps this catch confined to "something else's cancellation", the case that genuinely needs
        // a deliberate, loud disposition.
        catch (OperationCanceledException ex) when (!ct.IsCancellationRequested)
        {
            throw new FailedException($"the analysis was cancelled before it finished: {ex.Message}");
        }

        return outcome switch
        {
            LoopOutcome.Finding f => f.Value,

            // The analysis ran to completion and does not contribute. The exporter is gated on
            // Completed, so nothing leaves: silence is the all-clear.
            LoopOutcome.NoFinding n => throw new CancelledException($"nothing to report: {n.Reason}"),

            _ => throw new FailedException($"unrecognised loop outcome {outcome.GetType().Name}"),
        };
    }
}
