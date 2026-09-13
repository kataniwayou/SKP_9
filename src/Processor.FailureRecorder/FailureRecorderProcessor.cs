using System.Text.Json;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Microsoft.Extensions.Logging;

namespace Processor.FailureRecorder;

/// <summary>
/// Records that a step failed, and where to look. Wired on <c>entryCondition: PreviousFailed</c>
/// from every step of a workflow, and out to an exporter, so a failure leaves a durable record on a
/// broker rather than only a log line nobody is watching.
/// <para>
/// <b>It reads nothing and queries nothing.</b> The orchestrator hands it the failed step's input
/// blob, because a hop relocates its payload; this processor ignores those bytes entirely. It does
/// not query Elasticsearch either — it runs milliseconds after the failure, and the line carrying
/// the reason is the last one the failing pod writes and the furthest from being indexed.
/// </para>
/// </summary>
internal sealed class FailureRecorderProcessor(
    ILogger<FailureRecorderProcessor> logger,
    TimeProvider clock)
    : BaseProcessor<FailureRecorderConfig>
{
    protected override async Task ProcessAsync(
        byte[] data, FailureRecorderConfig? config, Guid executionId, CancellationToken ct)
    {
        // `data` and `config` are both deliberately unread. See FailureRecorderConfig for why a null
        // payload must not be rejected, and the type remarks above for the cargo.

        var record = new FailureRecord(
            // "N". The one formatting decision in this assembly that can silently break the feature.
            CorrelationKeys.Render(CorrelationId),
            executionId == Guid.Empty ? null : executionId.ToString("D"),
            clock.GetUtcNow());

        // THE LINEAGE THIS BRANCH TRAVELS ON, which is NOT always the one the record reports.
        //
        // A transform continues the lineage it was handed and never mints one. This is the single
        // exception, and only for a failed ENTRY step: an importer failure carries Guid.Empty, and
        // passing that on would dispatch the exporter downstream as an entry step, where
        // BaseExporter's first guard throws -- "it ends a lineage and cannot open one". The record
        // would never be exported, for exactly the failure class that most needs one.
        //
        // The minted id is plumbing. The record's own ExecutionId stays null above, because that
        // field describes the step that FAILED, and a step that failed before opening a lineage has
        // none. Conflating the two would have the record name a lineage the failure never had.
        var lineage = executionId == Guid.Empty ? NewExecutionId() : executionId;

        // Ids only, never the cargo. RecordedExecutionId rather than ExecutionId: the dispatch scope
        // already carries an ExecutionId attribute, and reusing the name would collide with it on
        // the record.
        //
        // TWO TEMPLATES, NOT ONE WITH A SENTINEL. A prose stand-in for the absent id -- "(none)" --
        // would put text into a structured attribute, which is precisely what FailureRecord refuses
        // to do on the wire: an operator filtering `exists: RecordedExecutionId` to find the
        // entry-step failures would match every record instead. Absence has to be absence here too,
        // which is the same rule ExecutionLogScope follows when it omits an empty id rather than
        // rendering zeros.
        if (record.ExecutionId is { } execution)
        {
            logger.LogInformation(
                "recorded a failed step: correlation {RecordedCorrelationId}, execution {RecordedExecutionId}",
                record.CorrelationId, execution);
        }
        else
        {
            logger.LogInformation(
                "recorded a failed step that had no lineage: correlation {RecordedCorrelationId}",
                record.CorrelationId);
        }

        await SendToPostAsync(
            JsonSerializer.SerializeToUtf8Bytes(record, FailureRecordJson.Options),
            lineage,
            ct).ConfigureAwait(false);
    }
}
