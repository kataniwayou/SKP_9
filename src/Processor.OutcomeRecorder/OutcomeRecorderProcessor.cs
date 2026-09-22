using System.Text.Json;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Microsoft.Extensions.Logging;

namespace Processor.OutcomeRecorder;

/// <summary>
/// Records that a step reached a terminal outcome, and where to look. Wired from every step of a
/// workflow and out to an exporter, so an outcome leaves a durable record on a broker rather than
/// only a log line nobody is watching.
/// <para>
/// <b>IT DOES NOT KNOW WHICH OUTCOME DISPATCHED IT, AND IT DOES NOT NEED TO.</b>
/// <see cref="NextStepHandoff"/> carries no result — the predecessor's outcome is consumed by
/// <c>StepAdvancement.SelectNext</c> and discarded — so nothing here can branch on the reason, and
/// nothing does. That is why the name is the generic one: the entry condition a workflow wires this
/// on is the workflow's business, and this processor behaves identically on every one of them.
/// The reason lives in the failing or cancelling step's own log line, resolved by correlation id.
/// </para>
/// <para>
/// <b>It reads nothing and queries nothing.</b> The orchestrator hands it the predecessor's input
/// blob, because a hop relocates its payload; this processor ignores those bytes entirely. It does
/// not query Elasticsearch either — it runs milliseconds after the outcome, and the line carrying
/// the reason is the last one the predecessor's pod writes and the furthest from being indexed.
/// </para>
/// </summary>
internal sealed class OutcomeRecorderProcessor(
    ILogger<OutcomeRecorderProcessor> logger,
    TimeProvider clock)
    : BaseProcessor<OutcomeRecorderConfig>
{
    protected override async Task ProcessAsync(
        byte[] data, OutcomeRecorderConfig? config, Guid executionId, CancellationToken ct)
    {
        // `data` and `config` are both deliberately unread. See OutcomeRecorderConfig for why a null
        // payload must not be rejected, and the type remarks above for the cargo.

        var record = new OutcomeRecord(
            // "N". The one formatting decision in this assembly that can silently break the feature.
            CorrelationKeys.Render(CorrelationId),
            executionId == Guid.Empty ? null : executionId.ToString("D"),
            clock.GetUtcNow());

        // THE LINEAGE THIS BRANCH TRAVELS ON, which is NOT always the one the record reports.
        //
        // A transform continues the lineage it was handed and never mints one. This is the single
        // exception, and the condition is ABSENT LINEAGE rather than any particular outcome: a
        // predecessor that ended before opening one -- an importer, typically -- carries Guid.Empty,
        // and passing that on would dispatch the exporter downstream as an entry step, where
        // BaseExporter's first guard throws -- "it ends a lineage and cannot open one". The record
        // would never be exported, for exactly the class of outcome that most needs one.
        //
        // The minted id is plumbing. The record's own ExecutionId stays null above, because that
        // field describes the PREDECESSOR, and a step that ended before opening a lineage has none.
        // Conflating the two would have the record name a lineage the predecessor never had.
        var lineage = executionId == Guid.Empty ? NewExecutionId() : executionId;

        // Ids only, never the cargo. RecordedExecutionId rather than ExecutionId: the dispatch scope
        // already carries an ExecutionId attribute, and reusing the name would collide with it on
        // the record.
        //
        // TWO TEMPLATES, NOT ONE WITH A SENTINEL. A prose stand-in for the absent id -- "(none)" --
        // would put text into a structured attribute, which is precisely what OutcomeRecord refuses
        // to do on the wire: an operator filtering `exists: RecordedExecutionId` to find the
        // entry-step outcomes would match every record instead. Absence has to be absence here too,
        // which is the same rule ExecutionLogScope follows when it omits an empty id rather than
        // rendering zeros.
        //
        // NEITHER TEMPLATE NAMES AN OUTCOME. Saying "failed" here would be this processor asserting
        // something it was never told; the predecessor already logged its own result, under the same
        // correlation id, with a Result attribute on the record.
        if (record.ExecutionId is { } execution)
        {
            logger.LogInformation(
                "recorded a step outcome: correlation {RecordedCorrelationId}, execution {RecordedExecutionId}",
                record.CorrelationId, execution);
        }
        else
        {
            logger.LogInformation(
                "recorded a step outcome that had no lineage: correlation {RecordedCorrelationId}",
                record.CorrelationId);
        }

        await SendToPostAsync(
            JsonSerializer.SerializeToUtf8Bytes(record, OutcomeRecordJson.Options),
            lineage,
            ct).ConfigureAwait(false);
    }
}
