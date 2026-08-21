using Messaging.Transport;

namespace BaseProcessor.Core.Processing;

/// <summary>
/// Everything the seam helpers need about the dispatch currently being handled: the sender to reach
/// the post queue with, and the four ids every branch is stamped with.
/// <para>
/// <b>The dispatch's own entry id is not here, and its absence is load-bearing information.</b> It
/// used to be, as the seed a branch's derived id was built from. Branch ids are now minted with
/// <see cref="Guid.NewGuid"/>, so nothing in the seam reads it — and the reclaim that <i>does</i> read
/// it takes it straight off the <see cref="Messaging.Contracts.ProcessDispatch"/> in
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
    public IQueueSender Sender { get; } = sender;
    public Guid CorrelationId { get; } = correlationId;
    public Guid WorkflowId { get; } = workflowId;
    public Guid StepId { get; } = stepId;
    public Guid ProcessorId { get; } = processorId;
}
