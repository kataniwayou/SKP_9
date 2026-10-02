namespace Messaging.Contracts;

/// <summary>
/// The run's two edges, as stamped on orchestrator records: the log-scope key and its two values.
/// <para>
/// <b>entry</b> is on the scheduler's "dispatched an entry step" record, one per entry step that
/// reached a queue (a fire with two entry steps writes two). <b>terminal</b> is on the branch-ends
/// record of a step with no successors in the workflow's graph, whatever its result. No other record
/// carries the key: steps between the edges are counted by the step-outcomes panel, not here.
/// </para>
/// <para>
/// <b>Decided by the orchestrator from its own L1 graph</b>, with no lookup: entry is hardcoded on the
/// dispatch line, terminal is <c>NextStepIds</c> empty on the step the outcome handler already holds.
/// A step shared by two workflows is classified per workflow.
/// </para>
/// <para>
/// <b>Here in the contracts assembly because the readers do not share a compiler with the emitter</b>
/// -- the Kibana dashboard and the Analyst select on these strings.
/// </para>
/// </summary>
public static class StepRoles
{
    public const string Key = "StepRole";

    public const string Entry = "entry";

    public const string Terminal = "terminal";

    public static IReadOnlyDictionary<string, object> Scope(string role)
        => new Dictionary<string, object>(1) { [Key] = role };
}
