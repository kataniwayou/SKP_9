namespace Messaging.Contracts;

/// <summary>
/// The orchestrator's one record per returned outcome: exactly one of these two lines is written for
/// every outcome StepOutcomeHandler processes, and it is the record that carries StepRole. The funnel
/// (Kibana pie and the Analyst panel) counts by these templates, so they live where both can see them.
/// </summary>
public static class OutcomeTemplates
{
    /// <summary>No successor accepted the result; the branch ends at this step.</summary>
    public const string BranchEnds =
        "the terminal step completed with {Result} — no successor accepts it, the run ends here";

    /// <summary>One or more successors accepted the result.</summary>
    public const string Advanced = "advanced {SuccessorCount} successor(s) in {ElapsedMs}ms";

    public static IReadOnlyList<string> All { get; } = [BranchEnds, Advanced];

    /// <summary>
    /// The opening half of a run's record: an entry step's outcome, one per run of a workflow entry
    /// step. Napole counts it as the run's root when it checks that every branch has ended.
    /// <para>
    /// <b>Not in <see cref="All"/>.</b> That list is the funnel's one-record-per-outcome set, and this
    /// line rides beside an entry step's <see cref="Advanced"/> or <see cref="BranchEnds"/> record
    /// rather than replacing it. An entry step that fails or cancels writes it with an empty execution
    /// id, which the log scope leaves out, so only a run that produced an execution carries one.
    /// </para>
    /// </summary>
    public const string EntryCompleted = "the entry step completed with {Result}";

    /// <summary>
    /// The warning written before <see cref="Advanced"/> when a Failed or Cancelled step still
    /// advances, because a successor's entry condition accepts that result. It is the only record that
    /// says such a step did not complete. Napole reads its <c>Result</c> as that step run's outcome.
    /// Not in <see cref="All"/>: the step's one outcome record is the <see cref="Advanced"/> line that
    /// follows it.
    /// </summary>
    public const string AdvancedAnyway =
        "advancing {SuccessorCount} successor(s) on a {Result} step — their entry conditions accept it";
}
