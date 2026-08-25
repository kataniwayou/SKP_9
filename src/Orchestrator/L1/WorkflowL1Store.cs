using System.Collections.Concurrent;
using System.Diagnostics.CodeAnalysis;
using Messaging.Contracts;

namespace Orchestrator.L1;

/// <summary>
/// One workflow as this replica currently holds it: the definition mirrored out of L2, the id of the
/// Quartz job standing for it right now, and — once it has been stopped — the instant the stop was
/// applied.
/// <para>
/// <b>The job id lives here and nowhere else.</b> It is minted per activation and never leaves the
/// replica — L2 has no job id, and two replicas holding the same workflow hold different ones. Pairing
/// it with the definition is what lets a second activation find the job the first one stood up, and
/// what lets a fire ask whether it is still the current one.
/// </para>
/// </summary>
/// <param name="Definition">The workflow as L2 described it at the moment of activation.</param>
/// <param name="JobId">The Quartz job standing for this workflow on this replica.</param>
/// <param name="DeletedAt">
/// When a stop was applied to this workflow, or null while it is running.
/// <para>
/// <b>A stop marks rather than deletes, and this field is the mark.</b> Removing the entry outright
/// settled the control plane instantly and broke the data plane for the length of one round trip:
/// every step still in flight came back to <c>StepOutcomeHandler</c>, found no workflow in L1, and was
/// parked. Keeping the definition reachable for a grace period lets those outcomes resolve and the run
/// drain, while <see cref="WorkflowL1Store.TryGetActive"/> keeps the workflow off every path that
/// could start new work.
/// </para>
/// <para>
/// <b>It is a mark, not a delay.</b> The stop still unschedules the Quartz job immediately — a stopped
/// workflow dispatches nothing from the moment the stop lands. All that survives the mark is the
/// ability to resolve an outcome for work already sent.
/// </para>
/// </param>
public sealed record L1Entry(WorkflowL1 Definition, Guid JobId, DateTimeOffset? DeletedAt = null)
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
    /// <para>
    /// <b>A <c>with</c>-expression does not rebuild it.</b> The record copy constructor copies backing
    /// fields and does not re-run initializers, so stamping <see cref="DeletedAt"/> on a stop keeps the
    /// map built at activation. That is what makes marking cheap enough to do on the control path.
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
/// <para>
/// <b>There is no bare <c>TryGet</c>, deliberately.</b> A stopped workflow stays in the dictionary for
/// a grace period, so "is it here" and "may it do work" stopped being the same question — and every
/// caller has to answer the second one. Two named lookups force that choice to be made rather than
/// inherited: <see cref="TryGetActive"/> for anything that could start new work,
/// <see cref="TryGetIncludingStopped"/> for anything resolving work already in flight. A single
/// <c>TryGet</c> would let a new call site pick the wrong one by writing nothing at all, and the wrong
/// one on the fire path resurrects a stopped workflow on its next tick.
/// </para>
/// </summary>
public sealed class WorkflowL1Store
{
    private readonly ConcurrentDictionary<Guid, L1Entry> _entries = new();

    /// <summary>
    /// The entry for <paramref name="workflowId"/> if this replica holds it AND it has not been
    /// stopped. The lookup for every path that could start new work — the fire job's dispatch and its
    /// self-reschedule both read through here, and a stopped workflow has to be invisible to both or
    /// the stop would undo itself on the next tick.
    /// </summary>
    public bool TryGetActive(Guid workflowId, [MaybeNullWhen(false)] out L1Entry entry)
    {
        if (_entries.TryGetValue(workflowId, out var held) && held.DeletedAt is null)
        {
            entry = held;
            return true;
        }

        entry = null;
        return false;
    }

    /// <summary>
    /// The entry for <paramref name="workflowId"/> if this replica holds it at all, stopped or not.
    /// <para>
    /// The lookup for resolving work already in flight: a step outcome for a workflow stopped while
    /// that step was running resolves here, which is the whole reason a stop marks instead of deleting.
    /// Also the lookup the activation and stop paths use, because both need to see the entry they are
    /// about to replace or mark.
    /// </para>
    /// </summary>
    public bool TryGetIncludingStopped(Guid workflowId, [MaybeNullWhen(false)] out L1Entry entry) =>
        _entries.TryGetValue(workflowId, out entry);

    /// <summary>
    /// Put <paramref name="definition"/> in L1 under <paramref name="jobId"/>, replacing whatever was
    /// there. Replacement is the normal case: every activation of an already-held workflow lands here.
    /// <para>
    /// <b>This is what clears a stop.</b> The new entry carries no <see cref="L1Entry.DeletedAt"/>, so
    /// starting a workflow inside its grace period un-marks it as a side effect of the write rather
    /// than through a separate call the activation path could forget to make.
    /// </para>
    /// </summary>
    public void Set(Guid workflowId, WorkflowL1 definition, Guid jobId) =>
        _entries[workflowId] = new L1Entry(definition, jobId);

    /// <summary>
    /// Stamp <paramref name="workflowId"/> as stopped at <paramref name="deletedAt"/>, reporting
    /// whether this call is what stamped it.
    /// <para>
    /// <b>An already-stamped entry is left alone, and that is what makes a redelivered stop safe.</b>
    /// Refreshing the stamp would push the reap out by a full grace period per duplicate delivery, so a
    /// stop redelivered on a loop would keep a stopped workflow resolvable indefinitely.
    /// </para>
    /// <para>
    /// The retry loop is a compare-and-swap against the entry that was read, so a concurrent
    /// <see cref="Set"/> does not have its fresh entry marked as stopped. Value equality is sound as
    /// the comparison because <see cref="L1Entry.JobId"/> is minted per activation — a replacement
    /// entry cannot compare equal to the one it replaced.
    /// </para>
    /// </summary>
    public bool MarkDeleted(Guid workflowId, DateTimeOffset deletedAt)
    {
        while (_entries.TryGetValue(workflowId, out var current))
        {
            if (current.DeletedAt is not null)
            {
                return false;
            }

            if (_entries.TryUpdate(workflowId, current with { DeletedAt = deletedAt }, current))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Drop every entry stopped at or before <paramref name="cutoff"/>, returning the ids dropped.
    /// <para>
    /// <b>Non-strict, matching the other thresholds in this codebase</b> — the boundary instant counts
    /// as expired, so a grace period reads as the number it is written as.
    /// </para>
    /// <para>
    /// The removal is a compare-and-remove against the entry the scan saw, so a workflow restarted
    /// between the scan and the removal is not reaped: the restart wrote a new entry, the pair no
    /// longer matches, and the reap skips it. A plain single-argument <c>TryRemove</c> would delete the
    /// running workflow an operator had just restarted.
    /// </para>
    /// </summary>
    public IReadOnlyList<Guid> ReapDeletedBefore(DateTimeOffset cutoff)
    {
        List<Guid> reaped = [];

        foreach (var (workflowId, entry) in _entries)
        {
            if (entry.DeletedAt is { } deletedAt &&
                deletedAt <= cutoff &&
                _entries.TryRemove(new KeyValuePair<Guid, L1Entry>(workflowId, entry)))
            {
                reaped.Add(workflowId);
            }
        }

        return reaped;
    }
}
