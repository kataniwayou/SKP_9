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

    /// <summary>
    /// The correlation id of the dispatch currently being handled.
    /// <para>
    /// <b>Read-only, and that is the whole of the concession.</b> No id here can be STAMPED on
    /// outgoing work — <see cref="SendToPostAsync"/> takes every id from <see cref="DispatchState"/>
    /// and none from the author, and that is unchanged. Reading is not forging.
    /// </para>
    /// <para>
    /// <b>All four ids are exposed, which reverses an earlier decision, and the reason belongs
    /// here.</b> The other three used to stay private on the argument that a static id "can reach an
    /// author through its step payload if they are ever wanted". That is precisely what SKNormalizer's
    /// whitelist address did, and the cost was a workflow id transcribed by hand into a payload string
    /// with nothing on any path keeping the copy equal to the workflow's own id — not the four start
    /// gates, and not <c>PayloadConfigSchemaValidator</c>, which checks shape and passes any string.
    /// An author composing a key from <see cref="WorkflowId"/> cannot get that wrong; an operator
    /// typing the same id into JSON can, and nothing would tell them. What is accepted in trade is
    /// that an author COULD now branch on its position in the graph. Nothing does, and a review that
    /// meets the first one should treat it as the smell it is.
    /// </para>
    /// <para>
    /// It exists for <c>Processor.OutcomeRecorder</c>, which runs on another step's behalf and must
    /// name something an operator can query. An entry step's dispatch carries
    /// <see cref="Guid.Empty"/> as its execution id, so the correlation id — minted once per fire by
    /// the orchestrator — is the only key that is present on every dispatch.
    /// </para>
    /// <para>
    /// Throws outside a dispatch, inheriting <see cref="Current"/>'s guard: a pooled thread must not
    /// hand back the previous dispatch's id.
    /// </para>
    /// </summary>
    protected Guid CorrelationId => Current.CorrelationId;

    /// <summary>
    /// The workflow this dispatch belongs to.
    /// <para>
    /// <b>Static for the life of the step, unlike <see cref="CorrelationId"/>, which is minted per
    /// fire.</b> That is what makes it the id to build a durable key from: a projection written once
    /// when the workflow started is addressed by this and not by any one run of it.
    /// </para>
    /// <para>
    /// <b>Reading is not forging.</b> <see cref="SendToPostAsync"/> still takes every id it stamps
    /// from <see cref="DispatchState"/> and none from the author. Exposing these changes what an
    /// author can READ, and nothing about what it can put on its own output.
    /// </para>
    /// <para>Throws outside a dispatch, inheriting <see cref="Current"/>'s guard.</para>
    /// </summary>
    protected Guid WorkflowId => Current.WorkflowId;

    /// <inheritdoc cref="WorkflowId"/>
    protected Guid StepId => Current.StepId;

    /// <inheritdoc cref="WorkflowId"/>
    protected Guid ProcessorId => Current.ProcessorId;

    /// <summary>Framework entry point, supplied by <see cref="BaseProcessor{TConfig}"/>.</summary>
    internal abstract Task ExecuteAsync(byte[] data, string payload, Guid executionId, CancellationToken ct);

    /// <summary>Opens a dispatch. Called by the pre handler before it invokes the seam.</summary>
    internal void BeginDispatch(DispatchState state) => Volatile.Write(ref _dispatch, state);

    /// <summary>Closes it, in a finally, so stale ids cannot outlive the dispatch on a pooled thread.</summary>
    internal void EndDispatch() => Volatile.Write(ref _dispatch, null);

    /// <summary>
    /// True for an author that deliberately produces no branch, so returning normally IS the end of
    /// the lineage. False everywhere else, which is every transform and every source.
    /// <para>
    /// <b>The pre handler reports a terminal outcome on this, and it must be a property of the CLASS
    /// rather than an observation of the dispatch.</b> "Sent no branch" looks like the same
    /// condition and is not: a <c>BaseImporter</c> whose source drained sends no branch either, and
    /// reporting Completed for it would advance every successor gated on
    /// <c>PreviousCompleted</c> — dispatching the rest of the workflow on an empty topic. That step
    /// produced nothing because there was nothing to produce; this one produces nothing because
    /// producing nothing is what it does.
    /// </para>
    /// </summary>
    internal virtual bool EndsLineage => false;

    /// <summary>
    /// The concrete <c>TConfig</c> this author binds its step payload to, so startup can check the
    /// registered config schema actually describes it.
    /// <para>
    /// On the non-generic base because that is what the container resolves and what
    /// <c>ProcessorStartupOrchestrator</c> can therefore take. The generic subclass supplies the
    /// answer; nothing else needs to know the type.
    /// </para>
    /// </summary>
    internal abstract Type ConfigType { get; }

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
            // The POST queue, not the work queue. A branch is the idempotent half of this hop -- the
            // handler that takes it writes L2[EntryId] = Data from the message alone -- so it gets its
            // own delivery, its own retry and its own dead-letter queue. It also keeps branch work off
            // the lane an author occupies: prefetch is 1 per consumer, and an author is the one stage
            // here with no bound on how long it holds its slot. See ProcessorQueues.Post.
            await state.Sender
                .SendTransientAsync(ProcessorQueues.Post(state.ProcessorId), MessageTypes.ProcessedData, branch, ct)
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
