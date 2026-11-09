using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Processor.Napole;

/// <summary>
/// The scheduled round-trip reporter: on each tick, how the watched workflow's executions imported in
/// the last window ended, as one count report handed to its successor (a kafka-exporter).
/// <para>
/// <b>Its workflow's ENTRY step</b>, so <c>executionId</c> arrives as <see cref="Guid.Empty"/>. It opens
/// a lineage exactly as the Analyst does: the kafka-exporter refuses an empty id, and a source step is
/// never replayed, so a fresh random id cannot fork a run. A dispatch that does arrive with an id is
/// continuing someone else's lineage and stays in it.
/// </para>
/// <para>
/// <b>Nothing terminated in the window is a Cancelled step, never a silent return.</b> The framework
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
                "Napole needs a step payload naming watchedWorkflowId, fromStepId, toStepId, windowMinutes and reporterSubComponentName");
        }

        var report = await ReportAsync(config, ct).ConfigureAwait(false);
        if (report is null)
        {
            var window = WindowFor(config);
            throw new CancelledException(
                $"no executions of {config.WatchedWorkflowId} terminated in {window.From:o}..{window.To:o}");
        }

        // PostSendException must propagate: the framework takes the duplicate over a lost report.
        await SendToPostAsync(
            report.Serialize(), executionId == Guid.Empty ? NewExecutionId() : executionId, ct).ConfigureAwait(false);
    }

    /// <summary>The tick, short of sending: the report, or null when nothing in the window terminated.</summary>
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

        if (string.IsNullOrWhiteSpace(config.ReporterSubComponentName))
        {
            throw new FailedException("Napole's reporterSubComponentName is empty");
        }

        var window = WindowFor(config);
        var trails = await source.ReadAsync(
            config.WatchedWorkflowId, window, TimeSpan.FromMinutes(options.Value.TrailMinutes), ct).ConfigureAwait(false);

        var report = ReportBuilder.Build(
            window, trails.Select(RoundTripRules.Decide), options.Value.Report, config.ReporterSubComponentName, clock.GetUtcNow());

        if (report is { } r)
        {
            var m = r.MandatoryMeasurments;
            logger.LogInformation(
                "reported {InputCount} executions of {WatchedWorkflowId}: {OutputCount} complete, {DiscardedCount} discarded, "
                + "{FailedCount} failed, window {ReportFromTime}..{ReportToTime}",
                m.InputCount, config.WatchedWorkflowId, m.OutputCount, m.DiscardedCount, m.FailedCount,
                r.CommonDimentions.ReportFromTime, r.CommonDimentions.ReportToTime);
        }

        return report;
    }

    private ReportWindow WindowFor(NapoleConfig config)
        => ReportWindow.For(clock.GetUtcNow(), config.WindowMinutes, TimeSpan.FromSeconds(options.Value.LagSeconds));
}
