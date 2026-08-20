using Messaging.Transport;

namespace BaseProcessor.Core.Processing;

/// <summary>
/// Everything the seam helpers need about the dispatch currently being handled, plus the two
/// counters that make derived ids unique within it.
/// <para>
/// <b>Two counters, not one.</b> An author may take an execution id without sending, or send without
/// taking one; a shared counter would make each call's id depend on the other call's history, so two
/// runs that differ only in the order of those two operations would derive different ids. Separate
/// counters keep each sequence a function of its own call order.
/// </para>
/// </summary>
internal sealed class DispatchState(
    IQueueSender sender,
    Guid workflowId,
    Guid stepId,
    Guid processorId,
    Guid correlationId,
    Guid entryId)
{
    private int _messageSequence = -1;
    private int _executionSequence = -1;

    public IQueueSender Sender { get; } = sender;
    public Guid WorkflowId { get; } = workflowId;
    public Guid StepId { get; } = stepId;
    public Guid ProcessorId { get; } = processorId;
    public Guid CorrelationId { get; } = correlationId;
    public Guid EntryId { get; } = entryId;

    public int NextMessageSequence() => ++_messageSequence;

    public int NextExecutionSequence() => ++_executionSequence;
}
