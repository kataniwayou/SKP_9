namespace Messaging.Contracts;

/// <summary>
/// The two message templates a consumer writes when it refuses a delivery outright — the only record
/// that work was thrown away.
/// <para>
/// <b>Here, in the contracts assembly, because these strings are a wire format.</b> Nothing about a
/// log template belongs in a shared contract by default; these two are the exception because they are
/// the ONLY identifier a refused message has. A refusal produces no <c>StepOutcome</c>, moves no
/// latency series and carries no result attribute, so every reader that can see one at all selects it
/// by matching the template verbatim on <c>attributes.{OriginalFormat}</c>: the Kibana refusals panel,
/// the live suite's run classifier, and the Analyst's <c>refused-messages</c> panel. The emitter and
/// those readers share no compiler, so a one-byte edit here does not break a build — it makes all of
/// them return zero rows, which is indistinguishable from a deployment that is refusing nothing.
/// </para>
/// <para>
/// <b>The em dashes are written as backslash-u-2014 escapes,</b> for the reason
/// <c>BaseApi.Tests.Live.Resilience.Templates</c> gives at length: spelling U+2014 literally makes
/// correctness depend on the file's encoding surviving every tool that touches it, and a template
/// differing by one byte matches nothing.
/// </para>
/// <para>
/// <b><c>const</c>, not <c>static readonly</c>.</b> A logging call's template argument must be a
/// compile-time constant expression for CA2254 (and for the structured-logging source generators) to
/// see it as a template rather than as interpolated text.
/// </para>
/// </summary>
public static class RefusalTemplates
{
    /// <summary>
    /// The park: the handler failed deterministically, the delivery was rejected without requeue, AND
    /// the broker was actually told — so the message is now in the queue's dead-letter queue and an
    /// operator can go and look at it.
    /// </summary>
    public const string Parked =
        "refusing message of type {Type} on {Queue} \u2014 parked";

    /// <summary>
    /// The other half of the same catch block: the channel died before the broker heard the
    /// rejection, so the delivery is REDELIVERED rather than dead-lettered.
    /// <para>
    /// Said in full rather than as a flag, because the operator reading it is deciding whether to go
    /// looking in a dead-letter queue, and there will be nothing there. It accounts for a short
    /// ledger exactly as <see cref="Parked"/> does — the run did not advance — but it is not a park,
    /// and <c>pipeline_deadletter_depth</c> will never show it.
    /// </para>
    /// <para>
    /// <b>This template CONTAINS the word "parked".</b> A reader matching <see cref="Parked"/> as a
    /// substring rather than as an equality matches this one too, and over-counts parks. Pinned by
    /// <c>RefusalTemplateTests</c>.
    /// </para>
    /// </summary>
    public const string NotParked =
        "refusing message of type {Type} on {Queue} \u2014 NOT parked: the channel was gone before "
        + "the broker was told, so it will be redelivered rather than dead-lettered";
}
