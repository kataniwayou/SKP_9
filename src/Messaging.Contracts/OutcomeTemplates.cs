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
}
