using System.Collections.Concurrent;
using System.Diagnostics.CodeAnalysis;
using Messaging.Contracts;

namespace Orchestrator.L1;

/// <summary>
/// One workflow as this replica currently holds it: the definition mirrored out of L2, and the id of
/// the Quartz job standing for it right now.
/// <para>
/// <b>The job id lives here and nowhere else.</b> It is minted per activation and never leaves the
/// replica — L2 has no job id, and two replicas holding the same workflow hold different ones. Pairing
/// it with the definition is what lets a second activation find the job the first one stood up, and
/// what lets a fire ask whether it is still the current one.
/// </para>
/// </summary>
/// <param name="Definition">The workflow as L2 described it at the moment of activation.</param>
/// <param name="JobId">The Quartz job standing for this workflow on this replica.</param>
public sealed record L1Entry(WorkflowL1 Definition, Guid JobId)
{
    /// <summary>
    /// The definition's steps keyed by id, built once here rather than scanned per lookup.
    /// <para>
    /// <b>This is the hot path, which the entry-step scan in the fire job is not.</b> Every step
    /// outcome from every processor resolves one step and then every one of its successors through
    /// this map, on a queue shared by the whole deployment — where a fire touches one workflow on one
    /// schedule tick. A linear scan of the step list is fine at the second rate and not at the first.
    /// </para>
    /// <para>
    /// <b>Last one wins on a duplicate id, silently.</b> The step ids come from the workflow's own L2
    /// key set, which cannot hold a duplicate — a repeated id would have been one key written twice.
    /// Throwing on a condition the projection cannot produce would put an exception on the activation
    /// path to guard nothing.
    /// </para>
    /// </summary>
    public IReadOnlyDictionary<Guid, StepL1> Steps { get; } =
        Definition.Steps.GroupBy(s => s.StepId).ToDictionary(g => g.Key, g => g.Last());
}

/// <summary>
/// L1: the in-memory mirror of the workflows this replica has activated.
/// <para>
/// <b>A mirror, never a store.</b> L2 is the source of truth (spec invariant 2). Nothing here is
/// persisted and nothing here is authoritative; the whole of it is rebuilt from L2 on every start, and
/// where a message and L2 disagree, L2 wins. That is why this type has no I/O, no logging and no
/// lifecycle — it is a dictionary, and giving it any of those would invite it to be treated as
/// something that could be recovered from.
/// </para>
/// </summary>
public sealed class WorkflowL1Store
{
    private readonly ConcurrentDictionary<Guid, L1Entry> _entries = new();

    /// <summary>The entry for <paramref name="workflowId"/>, if this replica holds one.</summary>
    public bool TryGet(Guid workflowId, [MaybeNullWhen(false)] out L1Entry entry) =>
        _entries.TryGetValue(workflowId, out entry);

    /// <summary>
    /// Put <paramref name="definition"/> in L1 under <paramref name="jobId"/>, replacing whatever was
    /// there. Replacement is the normal case: every activation of an already-held workflow lands here.
    /// </summary>
    public void Set(Guid workflowId, WorkflowL1 definition, Guid jobId) =>
        _entries[workflowId] = new L1Entry(definition, jobId);

    /// <summary>
    /// Drop <paramref name="workflowId"/>, reporting whether it was there. The report is what makes
    /// the stop path idempotent — a second delivery finds nothing and can say so without guessing.
    /// </summary>
    public bool Remove(Guid workflowId) => _entries.TryRemove(workflowId, out _);
}
