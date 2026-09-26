using Messaging.Transport;

namespace BaseProcessor.Core.Processing;

/// <summary>
/// Everything the seam helpers need about the dispatch currently being handled: the sender to reach
/// the post queue with, and the four ids every branch is stamped with.
/// <para>
/// <b>The dispatch's own entry id is not here, and its absence is load-bearing information.</b> It
/// used to be, as the seed a branch's derived id was built from. Branch ids are now minted with
/// <see cref="Guid.NewGuid"/>, so nothing in the seam reads it — and the reclaim that <i>does</i> read
/// it takes it straight off the <c>ProcessDispatch</c> in
/// <see cref="ProcessDispatchHandler"/>, never from here. Carrying it anyway would leave a field that
/// looks like it feeds the ids on the way out, which is exactly what it no longer does.
/// </para>
/// <para>
/// <b>No sequence counters either, for the same reason.</b> Two of them lived here so that a branch's
/// position in the call sequence could separate one derived id from the next without either counter
/// depending on the other's history. Randomness separates the branches now, at the cost that a
/// replayed dispatch mints new ids rather than the ones it minted before — see
/// <see cref="BaseProcessor.SendToPostAsync"/> for what that costs and why it is accepted.
/// </para>
/// </summary>
internal sealed class DispatchState(
    IQueueSender sender,
    Guid correlationId,
    Guid workflowId,
    Guid stepId,
    Guid processorId)
{
    private bool _branchSent;

    public IQueueSender Sender { get; } = sender;
    public Guid CorrelationId { get; } = correlationId;
    public Guid WorkflowId { get; } = workflowId;
    public Guid StepId { get; } = stepId;
    public Guid ProcessorId { get; } = processorId;

    /// <summary>
    /// Whether the author sent at least one branch on this dispatch.
    /// <para>
    /// <b>A flag, not a count, and that is the whole question it answers.</b> The only thing worth
    /// knowing is zero versus not-zero: one branch is as valid as five, and how many a fan-out opens
    /// is the author's decision, which <see cref="BaseProcessor.SendToPostAsync"/> already documents
    /// as theirs alone. A counter would invite a check on the number, which this framework has no
    /// basis to make.
    /// </para>
    /// <para>
    /// <b>No interlocking, deliberately.</b> An author fanning out may send concurrently — a
    /// <c>Task.WhenAll</c> over branches is legitimate — but every one of those writers writes the
    /// same value, so there is no update to lose under any interleaving, and a <c>bool</c> write is
    /// atomic regardless. <c>Volatile</c> is here for visibility only, matching
    /// <see cref="BaseProcessor.BeginDispatch"/>'s own idiom; strictly even that is belt-and-braces,
    /// since the reader in <c>ProcessDispatchHandler</c> runs after awaiting the author's transform
    /// and the await already establishes the edge.
    /// </para>
    /// </summary>
    public bool BranchSent => Volatile.Read(ref _branchSent);

    /// <summary>Records that a branch reached the post queue. Called only after the send returns.</summary>
    internal void MarkBranchSent() => Volatile.Write(ref _branchSent, true);
}
