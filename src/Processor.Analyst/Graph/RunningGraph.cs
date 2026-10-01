using Messaging.Contracts;

namespace Processor.Analyst.Graph;

/// <summary>
/// The target workflow as it is actually running: the projection its last start wrote to L2, plus the
/// display names of its steps and processors.
/// <para>
/// <b>The running graph, not the configured one.</b> A started workflow executes the projection taken
/// at its start; an edit to the rows since then is not in effect until the next start. A graph read
/// from the database would describe a workflow that is not the one producing the evidence.
/// </para>
/// </summary>
/// <param name="Live">Whether the workflow is in the live set, i.e. started and not stopped.</param>
/// <param name="Names">Display names by id, for the workflow, its steps and its processors. A missing
/// name is not an error: the id stands in for it.</param>
internal sealed record RunningGraph(
    Guid WorkflowId,
    bool Live,
    string? Cron,
    IReadOnlyList<Guid> EntryStepIds,
    IReadOnlyList<StepL1> Steps,
    IReadOnlyDictionary<Guid, string> Names);

/// <summary>What a dispatch knows about the target's graph: the graph itself, or why it could not be read.</summary>
internal sealed record GraphBriefing(RunningGraph? Graph, string? Unavailable)
{
    internal static GraphBriefing Of(RunningGraph graph) => new(graph, null);

    internal static GraphBriefing Missing(string why) => new(null, why);
}

/// <summary>Where a dispatch gets the target's running graph. Read by the processor, never by the model.</summary>
internal interface IWorkflowGraphSource
{
    Task<GraphBriefing> ReadAsync(Guid workflowId, CancellationToken ct);
}
