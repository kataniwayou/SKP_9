using BaseApi.Service.Features.Orchestration;

namespace BaseApi.Service.Features.Lookup;

/// <summary>
/// Turns a validated graph snapshot into the rows published at a start.
/// <para>
/// <b>The snapshot, not the entity tables.</b> What must be nameable is exactly what this workflow
/// can go on to emit, and a running workflow's composition is frozen at start by the L2 projection —
/// so the graph in hand at the moment of the start IS the set of ids whose logs will need labels.
/// Reading the tables instead would publish entities that never ran and still miss nothing, at the
/// cost of a query and of a table that drifts with every unrelated edit.
/// </para>
/// <para>
/// <b>No parent ids.</b> An entity is named here, not placed. Every processor in this system is
/// reachable from two or three workflows and several are bound to more than one step, so no single
/// row could carry one parent, and a row per path would make the id non-unique — which a match
/// policy resolves by picking one arbitrarily. The hierarchy the dashboard needs is already in the
/// log documents, which carry the whole id triple on every record.
/// </para>
/// </summary>
internal static class LookupRowExtractor
{
    public static IReadOnlyCollection<LookupRow> From(WorkflowGraphSnapshot snapshot)
    {
        var rows = new List<LookupRow>(
            snapshot.Workflows.Count + snapshot.Steps.Count + snapshot.Processors.Count);

        foreach (var w in snapshot.Workflows.Values)
            rows.Add(new LookupRow(w.Id, w.Name, w.Version, "workflow"));
        foreach (var s in snapshot.Steps.Values)
            rows.Add(new LookupRow(s.Id, s.Name, s.Version, "step"));
        foreach (var p in snapshot.Processors.Values)
            rows.Add(new LookupRow(p.Id, p.Name, p.Version, "processor"));

        return rows;
    }
}
