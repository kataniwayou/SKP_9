using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Processor.Napole;

/// <summary>
/// The scheduled section reporter: on each tick, it traces the executions that reached the section's
/// start step in the last window and counts the step outcomes where each one ended -- at the section's
/// end step if it got there, on the way if it did not -- as one report handed to its successor (a
/// kafka-exporter).
/// <para>
/// <b>Its workflow's ENTRY step</b>, so <c>executionId</c> arrives as <see cref="Guid.Empty"/>. It opens
/// a lineage exactly as the Analyst does: the kafka-exporter refuses an empty id, and a source step is
/// never replayed, so a fresh random id cannot fork a run. A dispatch that does arrive with an id is
/// continuing someone else's lineage and stays in it.
/// </para>
/// <para>
/// <b>Every tick sends one report; nothing counted in the window is a report of 0,0,0,0</b> (the user,
/// 2026-11-15, replacing "nothing finished → no report", spec §6), with a warning naming the section,
/// because a typo in a step id matches nothing and that warning is where it shows.
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

        // PostSendException must propagate: the framework takes the duplicate over a lost report.
        await SendToPostAsync(
            report.Serialize(), executionId == Guid.Empty ? NewExecutionId() : executionId, ct).ConfigureAwait(false);
    }

    /// <summary>The tick, short of sending: the report, of 0,0,0,0 when nothing in the window was counted.</summary>
    internal async Task<NapoleReport> ReportAsync(NapoleConfig config, CancellationToken ct)
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

        var reaches = trails.Select(ReachRules.Classify).ToList();
        var report = ReportBuilder.Build(
            window, trails.Select(ReachRules.Count), ReportDimensions.Of(config), clock.GetUtcNow());
        var m = report.MandatoryMeasurments;

        if (m.InputCount == 0)
        {
            // Both step ids, because a typo in one matches nothing and this warning is where it shows.
            logger.LogWarning(
                "no executions of workflow {WatchedWorkflowId} counted from step {FromStepId} to step {ToStepId}, "
                + "window {From:o}..{To:o}; a report with 0,0,0,0 is sent",
                config.WatchedWorkflowId, config.FromStepId, config.ToStepId, window.From, window.To);
        }
        else if (trails.All(t => t.Reached == 0))
        {
            // A typo in toStepId does not empty the answer the way one in fromStepId does: the executions are
            // still traced, none ever reaches the end, and a report with output 0 goes out every tick (final
            // review). So when counted executions exist and none reached toStepId, say so; whether that is a
            // typo or simply a window where nothing got there is the operator's call.
            logger.LogWarning(
                "none of the {Selected} executions of workflow {WatchedWorkflowId} that reached from step {FromStepId} in window "
                + "{From:o}..{To:o} reached to step {ToStepId}; if that is not expected, check the step id",
                trails.Count, config.WatchedWorkflowId, config.FromStepId, window.From, window.To, config.ToStepId);
        }

        // Executions with no proven end, and re-imports, are in no count; this line is the only place
        // they show.
        logger.LogInformation(
            "reported {InputCount} executions of workflow {WatchedWorkflowId} from step {FromStepId} to step {ToStepId}: "
            + "{OutputCount} output, {DiscardedCount} discarded, {FailedCount} failed; left out {NoEndCount} not in report, "
            + "{ReImportedCount} re-imported; window {ReportFromTime}..{ReportToTime}",
            m.InputCount, config.WatchedWorkflowId, config.FromStepId, config.ToStepId, m.OutputCount, m.DiscardedCount,
            m.FailedCount, reaches.Count(x => x == Reach.NoProvenEnd), reaches.Count(x => x == Reach.ReImported),
            report.CommonDimentions.ReportFromTime, report.CommonDimentions.ReportToTime);

        return report;
    }

    private ReportWindow WindowFor(NapoleConfig config)
        => ReportWindow.For(clock.GetUtcNow(), config.WindowMinutes, TimeSpan.FromSeconds(options.Value.LagSeconds));
}
