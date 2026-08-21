using Messaging.Transport;

namespace BaseProcessor.Core.Processing;

/// <summary>
/// A branch could not be handed to the post queue.
/// <para>
/// <b>It carries the branch's ids so an author fanning out can tell which one was lost</b> — that is
/// the only reason it exists rather than the plain <see cref="TransientSendException"/> it derives
/// from. Catching it is a detection point, not a handler: the exception must propagate, because the
/// dispatch has to be redelivered and replayed for the branch to be sent again.
/// </para>
/// <para>
/// <b>Re-throw with a bare <c>throw;</c>.</b> Wrapping it, or throwing a new exception, loses the
/// type — and the consumer classifies on the type. A wrapped one falls through to the generic path,
/// which reports the step as failed and acknowledges the message, so the step is recorded as a
/// business failure while the work is silently lost.
/// </para>
/// </summary>
public sealed class PostSendException : TransientSendException
{
    public PostSendException(Guid entryId, Guid executionId, Exception inner)
        : base($"send of branch {entryId:D} to the post queue failed", inner)
    {
        EntryId = entryId;
        ExecutionId = executionId;
    }

    /// <summary>The branch's entry id — the L2 key it would have written.</summary>
    public Guid EntryId { get; }

    /// <summary>The branch's execution id, naming the lineage that did not start.</summary>
    public Guid ExecutionId { get; }
}
