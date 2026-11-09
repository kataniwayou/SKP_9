using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Processor.Napole;

/// <summary>
/// The scheduled section reporter: on each tick, how the executions that reached the section's start
/// step in the last window ended inside the section, as one count report handed to its successor (a
/// kafka-exporter).
/// <para>
/// <b>Its workflow's ENTRY step</b>, so <c>executionId</c> arrives as <see cref="Guid.Empty"/>. It opens
/// a lineage exactly as the Analyst does: the kafka-exporter refuses an empty id, and a source step is
/// never replayed, so a fresh random id cannot fork a run. A dispatch that does arrive with an id is
/// continuing someone else's lineage and stays in it.
/// </para>
/// <para>
/// <b>Nothing counted in the window is a Cancelled step, never a silent return.</b> The framework
/// reports a step that returns without sending as Failed (the "one output rule" in
/// <c>ProcessDispatchHandler</c>), and an empty branch would fail the exporter instead. Cancelled is
/// the path the kafka-importer takes for an empty topic, and no report is sent (spec §6).
/// </para>
/// </summary>
public sealed class NapoleProcessor(
    IExecutionTrailSource source,
    IOptions<NapoleOptions> options,
    TimeProvider clock,
    ILogger<NapoleProcessor> logger)
    : BaseProcessor<NapoleConfig>
{
    protected override async Task ProcessAsync(
        byte[] data, NapoleConfig? config, Guid executionId, CancellationToken ct)
    {
        if (config is null)
        {
            throw new FailedException(
                "Napole needs a step payload naming watchedWorkflowId, fromStepId, toStepId, windowMinutes, reporterComponentName, "
                + "reporterSubComponentName, reporterNetworkName, srcCode and sagCode");
        }

        var report = await ReportAsync(config, ct).ConfigureAwait(false);
        if (report is null)
        {
            var window = WindowFor(config);
            // Both step ids, because a typo in one matches nothing and this message is where it shows.
            throw new CancelledException(
                $"no executions of {config.WatchedWorkflowId} counted in section {config.FromStepId}..{config.ToStepId}, "
                + $"window {window.From:o}..{window.To:o}");
        }

        // PostSendException must propagate: the framework takes the duplicate over a lost report.
        await SendToPostAsync(
            report.Serialize(), executionId == Guid.Empty ? NewExecutionId() : executionId, ct).ConfigureAwait(false);
    }

    /// <summary>The tick, short of sending: the report, or null when nothing in the window was counted.</summary>
    internal async Task<NapoleReport?> ReportAsync(NapoleConfig config, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(config);

        // The schema refuses these at publish; a payload row edited by hand is not checked there, and
        // the schema lets a whitespace-only name through.
        if (config.WatchedWorkflowId == Guid.Empty)
        {
            throw new FailedException("Napole's watchedWorkflowId is empty");
        }

        if (config.FromStepId == Guid.Empty)
        {
            throw new FailedException("Napole's fromStepId is empty");
        }

        if (config.ToStepId == Guid.Empty)
        {
            throw new FailedException("Napole's toStepId is empty");
        }

        if (config.WindowMinutes < 1)
        {
            throw new FailedException($"Napole's windowMinutes must be at least 1; the payload named {config.WindowMinutes}");
        }

        foreach (var (name, value) in new[]
        {
            ("reporterComponentName", config.ReporterComponentName),
            ("reporterSubComponentName", config.ReporterSubComponentName),
            ("reporterNetworkName", config.ReporterNetworkName),
            ("srcCode", config.SrcCode),
            ("sagCode", config.SagCode),
        })
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                throw new FailedException($"Napole's {name} is empty");
            }
        }

        var window = WindowFor(config);
        var trails = await source.ReadAsync(
            WatchedSection.Of(config), window, TimeSpan.FromMinutes(options.Value.TrailMinutes), ct).ConfigureAwait(false);

        // A typo in toStepId does not empty the answer the way one in fromStepId does: the runs are still
        // selected, nothing ever reaches the end, and a plausible report with output 0 goes out every
        // tick (final review, Important 2). A failure-path end step looks the same, so this warns rather
        // than fails: the operator decides which it is.
        if (trails.Count > 0 && trails.All(t => t.Reached == 0))
        {
            logger.LogWarning(
                "none of the {Selected} executions of {WatchedWorkflowId} that reached {FromStepId} in window "
                + "{From:o}..{To:o} completed toStepId {ToStepId}; if that is not expected, check the step id",
                trails.Count, config.WatchedWorkflowId, config.FromStepId, window.From, window.To, config.ToStepId);
        }

        var verdicts = trails.Select(RoundTripRules.Decide).ToList();
        var report = ReportBuilder.Build(
            window, verdicts, ReportDimensions.Of(config), clock.GetUtcNow());

        if (report is { } r)
        {
            // Unfinished and bypassed runs are in no count; this line is the only place they show.
            var m = r.MandatoryMeasurments;
            logger.LogInformation(
                "reported {InputCount} executions of {WatchedWorkflowId} {FromStepId}..{ToStepId}: {OutputCount} complete, "
                + "{DiscardedCount} discarded, {FailedCount} failed; left out {UnfinishedCount} unfinished, "
                + "{BypassedCount} bypassed; window {ReportFromTime}..{ReportToTime}",
                m.InputCount, config.WatchedWorkflowId, config.FromStepId, config.ToStepId, m.OutputCount, m.DiscardedCount,
                m.FailedCount, verdicts.Count(v => v == RoundTrip.Unfinished), verdicts.Count(v => v == RoundTrip.Bypassed),
                r.CommonDimentions.ReportFromTime, r.CommonDimentions.ReportToTime);
        }

        return report;
    }

    private ReportWindow WindowFor(NapoleConfig config)
        => ReportWindow.For(clock.GetUtcNow(), config.WindowMinutes, TimeSpan.FromSeconds(options.Value.LagSeconds));
}
