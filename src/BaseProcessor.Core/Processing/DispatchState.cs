namespace BaseProcessor.Core.Processing;

/// <summary>
/// Everything the seam helpers need about the dispatch currently being handled: where a finished
/// branch goes, the input key branch ids are derived from, and the four ids every branch is stamped
/// with.
/// <para>
/// <b>The dispatch's own entry id is back, and it is load-bearing again.</b> A branch's key is
/// <see cref="Messaging.Contracts.EntryIds.Branch"/> of this input key and the branch's execution id,
/// so a replayed dispatch derives the same keys and L2 converges. <see cref="Guid.Empty"/> means an
/// entry step dispatched by the fire, which has no input key; the formula then falls back to the
/// workflow and step ids. The reclaim still takes the key straight off the <c>ProcessDispatch</c> in
/// <see cref="ProcessDispatchHandler"/>.
/// </para>
/// <para>
/// <b>No sequence counters.</b> The execution id separates one branch from the next — the author's
/// contract is a distinct execution id per output — so a position counter would add nothing but a
/// dependency on call order.
/// </para>
/// </summary>
internal sealed class DispatchState(
    IBranchSink sink,
    Guid inputEntryId,
    Guid correlationId,
    Guid workflowId,
    Guid stepId,
    Guid processorId)
{
    private bool _branchSent;

    public IBranchSink Sink { get; } = sink;
    public Guid InputEntryId { get; } = inputEntryId;
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

    /// <summary>Records that a branch was finished. Called only after the sink returns.</summary>
    internal void MarkBranchSent() => Volatile.Write(ref _branchSent, true);
}
