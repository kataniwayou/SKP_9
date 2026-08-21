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
    // Published with a Volatile.Write / Volatile.Read pair, matching ProcessorContext's identity
    // snapshot: DispatchState is fully constructed and then published, and .NET makes no Java-style
    // final-field promise, so the release/acquire barrier is explicit rather than inferred from the
    // record's immutability. Consecutive deliveries can land on different threadpool threads.
    // Consistency rather than a live bug — the RabbitMQ dispatcher's own synchronisation supplies the
    // barrier in practice at ConsumerDispatchConcurrency 1 — but that is a property of a setting one
    // file away, not of this class.
    private DispatchState? _dispatch;

    private DispatchState Current =>
        Volatile.Read(ref _dispatch) ?? throw new InvalidOperationException(
            "No dispatch is open. BeginDispatch must run before the seam helpers — this is a framework wiring fault.");

    /// <summary>Framework entry point, supplied by <see cref="BaseProcessor{TConfig}"/>.</summary>
    internal abstract Task ExecuteAsync(byte[] data, string payload, Guid executionId, CancellationToken ct);

    /// <summary>Opens a dispatch. Called by the pre handler before it invokes the seam.</summary>
    internal void BeginDispatch(DispatchState state) => Volatile.Write(ref _dispatch, state);

    /// <summary>Closes it, in a finally, so stale ids cannot outlive the dispatch on a pooled thread.</summary>
    internal void EndDispatch() => Volatile.Write(ref _dispatch, null);

    /// <summary>
    /// Hands one branch of output to the post queue.
    /// <para>
    /// The framework stamps every id: the dispatch's correlation, workflow, step and processor ids,
    /// plus a fresh entry id naming the L2 key this branch's output will be written to. The author
    /// supplies the bytes and the execution id and nothing else — an author cannot influence the ids
    /// on its own output, and the four it does not supply are the dispatch's own, passed through
    /// unchanged.
    /// </para>
    /// <para>
    /// <b>The entry id is random, and that is a decision with a cost.</b> A redelivered dispatch
    /// replays this call and mints a <i>different</i> id, so the replay writes a second blob and
    /// reports a second outcome — the successor subtree runs twice. Two things keep that narrow. The
    /// input-key delete in <see cref="ProcessDispatchHandler"/> is an idempotence token: once it lands,
    /// a redelivery reads the key absent and returns without re-running the author at all. And the
    /// orchestrator reclaims each output blob it relocates, so the duplicate leaks nothing. What is
    /// left is two reachable cases — the delete itself failing, and a source step, which has no key to
    /// read or delete and therefore no token — where the author genuinely runs twice.
    /// </para>
    /// <para>
    /// <b>That is safe exactly as far as authors are pure transforms.</b> A duplicate run of a
    /// transform computes the same answer twice and wastes cycles; a duplicate run of a step that
    /// writes a row or calls an API does it twice, and nothing here records that it did. Deriving the
    /// id from the dispatch instead would make the replay rewrite the same key and converge — that is
    /// what this used to do — and it is the change to make if an author with side effects ever lands.
    /// It is four lines in this method and no author code.
    /// </para>
    /// <para>
    /// The author supplies <paramref name="executionId"/>, because how many lineages a fan-out opens
    /// is a decision only they can make. <see cref="NewExecutionId"/> mints one.
    /// </para>
    /// </summary>
    protected async Task SendToPostAsync(byte[] processedData, Guid executionId, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(processedData);

        var state = Current;
        var entryId = Guid.NewGuid();

        var branch = new ProcessedData(
            state.CorrelationId, executionId, state.WorkflowId, state.StepId, state.ProcessorId,
            entryId, processedData);

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
            throw new PostSendException(entryId, executionId, ex);
        }
    }

    /// <summary>
    /// A fresh execution id for a branch. Use it wherever <c>Guid.NewGuid()</c> would otherwise go —
    /// it is that call today, and keeping the seam means changing how a lineage is opened stays a
    /// change to this one method rather than to every author.
    /// <para>
    /// It does not survive a replay, for the same reason and with the same consequences as the entry
    /// id above: a redelivered dispatch opens a second lineage rather than reopening the first.
    /// </para>
    /// </summary>
    protected Guid NewExecutionId()
    {
        // Reads Current for its side effect: opening a lineage outside a dispatch is a framework
        // wiring fault, and it must be as loud here as it is on the send path rather than quietly
        // handing back an id that belongs to no dispatch.
        _ = Current;
        return Guid.NewGuid();
    }
}
