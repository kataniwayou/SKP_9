namespace Processor.Napole;

/// <summary>
/// The log records Napole counts, named once.
/// <para>
/// <b>Only <c>StepRole</c> is a published contract</b> (<c>Messaging.Contracts.StepRoles</c>). The
/// two template prefixes below are log text: if their emitters reword them, Napole miscounts with no
/// error -- hand-offs vanish, every run looks fully returned, and an open branch reads as Complete.
/// Keep them in step with the emitters named here; the live check (plan Task 6) is what catches a
/// drift.
/// </para>
/// </summary>
internal static class TrailRecords
{
    /// <summary>Where the OTel collector writes every service's logs (the Analyst's index too).</summary>
    public const string Index = "logs-generic.otel-default";

    /// <summary>
    /// The orchestrator's <c>handed off to {NextStepId} on {NextProcessorId} with {NextEntryId}</c>, one
    /// per successor dispatched; <c>attributes.NextEntryId</c> names the branch.
    /// </summary>
    public const string HandedOff = "handed off";

    /// <summary>
    /// <c>BaseProcessor.Core</c>'s <c>ProcessDispatchHandler</c>: <c>the step returned after {ElapsedMs}ms</c>,
    /// one per dispatch a processor finished; <c>attributes.EntryId</c> names the branch it answered.
    /// </summary>
    public const string StepReturned = "the step returned";

    /// <summary>
    /// Each statement's <c>LIMIT</c>, Elasticsearch's default ES|QL result ceiling. An answer this long
    /// may be truncated, so it fails the tick rather than under-count.
    /// </summary>
    public const int RowLimit = 10_000;
}
