namespace Messaging.Contracts;

/// <summary>
/// Where in a run the record being written sits: the log-scope key and its three values.
/// <para>
/// <b>It describes THE RECORD, not the step.</b> A step's position is not a property of the step —
/// <c>StepAdvancement</c> calls a step terminal when no successor <i>accepted this outcome</i>, so the
/// same step is terminal on a run it cancelled and not on one it completed. And a step can be both
/// ends at once: a single-step workflow's entry step is also its terminal one, and emits both
/// completion records. A field named for the step could not represent either case; this one is read
/// as "what this line reports".
/// </para>
/// <para>
/// <b>Here in the contracts assembly because the readers do not share a compiler with the emitter.</b>
/// The orchestrator writes it; the Kibana dashboard and the Analyst's panels select on it. Same
/// reasoning as <see cref="RefusalTemplates"/>: a value retyped into a dashboard's JSON is a copy
/// nothing holds to the source, and the failure mode is a panel that reads zero rather than an error.
/// </para>
/// <para>
/// <b>It rides the log SCOPE, never a message template.</b> The templates it accompanies are pinned
/// contracts — <c>tools/verify-kibana-dashboard.py</c>, the live suite's ledger, saved Kibana queries —
/// so adding a parameter to one of them would break every existing reader. A scope key surfaces at
/// <c>attributes.RunPosition</c> through the OpenTelemetry <c>IncludeScopes</c> +
/// <c>ParseStateValues</c> bridge, exactly as <see cref="ExecutionLogScope"/>'s ids do, and leaves the
/// message text untouched.
/// </para>
/// <para>
/// <b>Only two records carry it: the dispatch that starts a run and the outcome that ends a branch.</b>
/// Everything in between -- handoffs, advancement, the entry step's own completion -- is left
/// untagged, so a terms aggregation on this field answers exactly the two questions it was added for
/// and nothing else.
/// </para>
/// </summary>
public static class RunPositions
{
    /// <summary>
    /// The scope key. Equal to the name a template parameter would use for the same thing, which is
    /// what <see cref="ExecutionLogScope"/>'s own doc comment requires of every key here: both paths
    /// have to surface at one <c>attributes.RunPosition</c> field.
    /// </summary>
    public const string Key = "RunPosition";

    /// <summary>
    /// The orchestrator put an entry step on a processor's queue. The ONLY value marking the start of
    /// a run: the entry step's own completion record is deliberately left untagged, because the
    /// counter this exists for is "how many entry steps were dispatched" and that is a different
    /// question from "how many lineages began" -- one per fire against one per item read. One record per entry step per fire,
    /// all of them under the fire's single correlation id — so a document count is dispatches and a
    /// distinct-correlation count is fires. The two coincide only while every workflow has one entry
    /// step.
    /// <para>
    /// <b>Leader-only, and needing no role clause to be so.</b> The line sits inside the dispatch
    /// branch that leadership gates, so a follower never reaches it. <c>attributes.role</c> is stamped
    /// at write time and reads <c>follower</c> on a leader's own record when the lease lapses
    /// mid-fire, which makes filtering on it lossy and pointless — there is nothing to exclude.
    /// </para>
    /// <para>
    /// Written only after the send succeeded, so a frozen entry step and a failed send are both
    /// absent: this counts entry steps that actually reached a queue.
    /// </para>
    /// </summary>
    public const string Entry = "entry";

    /// <summary>
    /// A branch ended: no successor accepted this outcome. Role-agnostic, one record per branch end,
    /// so a run fans out to as many as it has terminal branches — count distinct
    /// <c>ExecutionId</c> for lineages rather than documents.
    /// <para>
    /// <b>The reason this value is worth more than the template it accompanies:</b> only the
    /// orchestrator's own "the terminal step completed" line carries it. The exporter's
    /// processor-side witness — <c>ProcessedDataHandler</c>'s "branch completed in {ElapsedMs}ms" —
    /// is a different record entirely and never carries this attribute, so a terms aggregation on it
    /// cannot be confused with that one.
    /// </para>
    /// </summary>
    public const string Terminal = "terminal";

    /// <summary>
    /// The scope a record carrying one of these values opens. A single-entry dictionary rather than a
    /// literal at each call site, so the key cannot be misspelled on one of them.
    /// </summary>
    public static Dictionary<string, object> Scope(string position) =>
        new(1, StringComparer.Ordinal) { [Key] = position };
}
