namespace Messaging.Contracts;

/// <summary>
/// A step's place in its workflow's graph, as stamped on orchestrator records: the log-scope key and
/// its three values.
/// <para>
/// <b>A property of the graph, per workflow.</b> entry: the step is in the workflow's entryStepIds.
/// terminal: it has no successors. intermediate: every other step. A step shared by two workflows
/// has a role in each. BaseApi computes it when it writes the projection; the orchestrator only
/// reads it.
/// </para>
/// <para>
/// <b>Not a run event.</b> terminal means "a step with no successors returned an outcome", not "a
/// branch ended here": a cancelled item at an intermediate step is stamped intermediate.
/// </para>
/// <para>
/// <b>Here in the contracts assembly because the readers do not share a compiler with the emitter</b>
/// — the Kibana dashboard and the Analyst select on these strings.
/// </para>
/// </summary>
public static class StepRoles
{
    public const string Key = "StepRole";

    public const string Entry = "entry";

    public const string Intermediate = "intermediate";

    public const string Terminal = "terminal";

    public static IReadOnlyDictionary<string, object> Scope(string role)
        => new Dictionary<string, object>(1) { [Key] = role };
}
