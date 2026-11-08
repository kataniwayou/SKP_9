namespace Processor.Napole;

/// <summary>
/// Where Napole reads, and how much it reads at once.
/// <para>
/// <b>Every record it counts is selected by a published contract, not by log text.</b> Branches are
/// closed on <c>Messaging.Contracts.OutcomeTemplates</c> -- the orchestrator writes exactly one
/// <c>Advanced</c> or <c>BranchEnds</c> record for every outcome it handles -- and terminals on
/// <c>StepRoles</c>. The first version closed a branch on the processor's own "the step returned" line,
/// which is written before the orchestrator has seen the outcome, so a branch whose failure the
/// orchestrator had not yet recorded could read as Complete (final review, Important 2).
/// </para>
/// </summary>
internal static class TrailRecords
{
    /// <summary>Where the OTel collector writes every service's logs (the Analyst's index too).</summary>
    public const string Index = "logs-generic.otel-default";

    /// <summary>
    /// Each statement's <c>LIMIT</c>, Elasticsearch's default ES|QL result ceiling. An answer this long
    /// may be truncated, so it fails the tick rather than under-count.
    /// </summary>
    public const int RowLimit = 10_000;
}
