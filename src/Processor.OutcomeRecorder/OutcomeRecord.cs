using System.Text.Json;
using System.Text.Json.Serialization;

namespace Processor.OutcomeRecorder;

/// <summary>
/// The output contract: a pointer to a step outcome, never the outcome's reason.
/// <para>
/// <b>It carries no reason and no payload, deliberately.</b> <c>StepOutcome</c> has no text field,
/// so the reason exists only in the predecessor's own log line — and this processor is dispatched
/// milliseconds after that line is written, well before it is indexed. Racing the log pipeline was
/// measured and rejected; see the spec. An operator resolves this record against Elasticsearch at
/// their own pace.
/// </para>
/// <para>
/// <b>It does not name the outcome either, and that is not an omission.</b> The dispatch that
/// produced this record carries no result to name — see <c>OutcomeRecorderProcessor</c> — so a field
/// here could only ever restate the entry condition somebody wired, which is a property of the
/// workflow rather than of the run. The predecessor's own log record carries the result as an
/// attribute, under the correlation id below.
/// </para>
/// </summary>
/// <param name="CorrelationId">
/// The fire this outcome belongs to, rendered <b>"N"</b> — 32 hex characters, no dashes. That is the
/// form <c>CorrelationKeys.Render</c> puts on every log record, so this value pastes straight into a
/// term query. A dashed guid here matches nothing and reports no error.
/// </param>
/// <param name="ExecutionId">
/// The PREDECESSOR's lineage, rendered "D", or <b>null when it had none</b> — a step that ended
/// before opening one, such as an importer, is an entry dispatch and no lineage was ever opened.
/// Null is omitted from the JSON rather than written as a zero guid, matching
/// <c>ExecutionLogScope.BuildScope</c>: "does not apply" must stay distinguishable from "is the zero
/// guid", and a consumer must be written for an absent field. <b>It is not the id of the branch this
/// processor sends</b>, which may be freshly minted precisely because this one is absent.
/// </param>
/// <param name="RecordedAtUtc">
/// When this record was written — milliseconds after the outcome, on a different pod. Enough to
/// bound a query window and to tell two records in one lineage apart; not a clock to order events
/// by.
/// </param>
internal sealed record OutcomeRecord(string CorrelationId, string? ExecutionId, DateTimeOffset RecordedAtUtc);

/// <summary>The one serializer configuration for the outcome record.</summary>
internal static class OutcomeRecordJson
{
    /// <summary>
    /// <b>camelCase, pinned explicitly</b>, for the reason <c>FileLocatorJson</c> gives: the
    /// messaging envelope's own options leave the naming policy null — PascalCase — and inheriting
    /// that here would emit <c>CorrelationId</c>, which is not what a consumer of this topic is told
    /// to expect.
    /// <para>
    /// <b><c>WhenWritingNull</c>, unlike every other record in this solution.</b> An absent
    /// execution id must be ABSENT rather than null, so that a consumer distinguishes "this outcome
    /// had no lineage" from "this field was not populated".
    /// </para>
    /// </summary>
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}
