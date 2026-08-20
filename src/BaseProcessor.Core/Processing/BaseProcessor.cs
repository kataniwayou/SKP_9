using Messaging.Contracts;
using Messaging.Transport;

namespace BaseProcessor.Core.Processing;

/// <summary>
/// The type the pre handler resolves and calls. An author never derives from this directly — they
/// derive from <see cref="BaseProcessor{TConfig}"/>, which supplies this class's abstract member by
/// deserializing the payload first.
/// <para>
/// <b>The per-dispatch state is a plain field, and that is only safe at a prefetch of one.</b> One
/// dispatch runs at a time per replica, so nothing else can be mid-flight while this field is set.
/// Raising the prefetch would let one dispatch overwrite another's ids, and the branches of the
/// overwritten one would be sent under the wrong lineage — a wrong-key write with nothing to report
/// it. The reference hit exactly this and had to move the state into an <c>AsyncLocal</c>.
/// </para>
/// </summary>
public abstract class BaseProcessor
{
    private DispatchState? _dispatch;

    private DispatchState Current =>
        _dispatch ?? throw new InvalidOperationException(
            "No dispatch is open. BeginDispatch must run before the seam helpers — this is a framework wiring fault.");

    /// <summary>Framework entry point, supplied by <see cref="BaseProcessor{TConfig}"/>.</summary>
    internal abstract Task ExecuteAsync(byte[] data, string payload, Guid executionId, CancellationToken ct);

    /// <summary>Opens a dispatch. Called by the pre handler before it invokes the seam.</summary>
    internal void BeginDispatch(DispatchState state) => _dispatch = state;

    /// <summary>Closes it, in a finally, so stale ids cannot outlive the dispatch on a pooled thread.</summary>
    internal void EndDispatch() => _dispatch = null;

    /// <summary>
    /// Hands one branch of output to the post queue.
    /// <para>
    /// The framework stamps every id: the dispatch's workflow, step, correlation and entry ids, this
    /// processor's own id, and a derived message id. <b>The message id is derived rather than random
    /// on purpose</b> — a redelivered dispatch replays this call and must produce the id it produced
    /// before, so the post handler's write becomes a rewrite instead of a second branch.
    /// </para>
    /// <para>
    /// The author supplies <paramref name="executionId"/>, because how many lineages a fan-out opens
    /// is a decision only they can make. <see cref="NewExecutionId"/> mints one that survives a replay.
    /// </para>
    /// </summary>
    protected async Task SendToPostAsync(byte[] processedData, Guid executionId, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(processedData);

        var state = Current;
        var messageId = DeterministicId.From(
            DeterministicId.MessagePurpose,
            state.CorrelationId, state.StepId, state.EntryId, state.NextMessageSequence());

        var branch = new ProcessedData(state.WorkflowId, state.StepId, state.ProcessorId)
        {
            CorrelationId = state.CorrelationId,
            ExecutionId   = executionId,
            MessageId     = messageId,
            EntryId       = state.EntryId,
            Data          = processedData,
        };

        try
        {
            await state.Sender
                .SendTransientAsync(ProcessorQueues.Work(state.ProcessorId), MessageTypes.ProcessedData, branch, ct)
                .ConfigureAwait(false);
        }
        catch (TransientSendException ex)
        {
            // ONLY the already-classified fault is renamed. Naming it lets an author fanning out see
            // which branch was lost, and it stays a TransientSendException, so the consumer still
            // returns the dispatch to the queue.
            //
            // Catching Exception here instead would defeat the classification entirely: every
            // TransientSendException maps to Requeue, so wrapping a deterministic fault — one
            // SendFaultClassifier's allow-list deliberately declined to recognise — would requeue a
            // branch that fails identically on every redelivery, forever. An unrecognised fault has
            // to leave here raw so the dispatch parks where someone can look at it.
            throw new PostSendException(messageId, executionId, ex);
        }
    }

    /// <summary>
    /// A fresh execution id for a branch, derived so that a replayed dispatch opens the same lineage
    /// rather than a new one. Use it wherever <c>Guid.NewGuid()</c> would otherwise go.
    /// </summary>
    protected Guid NewExecutionId()
    {
        var state = Current;
        return DeterministicId.From(
            DeterministicId.ExecutionPurpose,
            state.CorrelationId, state.StepId, state.EntryId, state.NextExecutionSequence());
    }
}
