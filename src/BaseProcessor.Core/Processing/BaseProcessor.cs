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
    /// Hands one branch of output on, and returns once it is in L2 and its outcome is confirmed.
    /// <para>
    /// The framework stamps every id: the dispatch's correlation, workflow, step and processor ids,
    /// plus an entry id naming the L2 key this branch's output is written to. The author supplies the
    /// bytes and the execution id and nothing else.
    /// </para>
    /// <para>
    /// <b>The entry id is derived, not random</b> (<see cref="EntryIds.Branch"/>): from the dispatch's
    /// input key and <paramref name="executionId"/>, or for an entry step from the workflow, the step
    /// and <paramref name="executionId"/>. A redelivered dispatch replays this call, names the same
    /// key, rewrites the same bytes and reports the same outcome — L2 converges.
    /// </para>
    /// <para>
    /// <b>The author's contract: every output carries a distinct, non-empty execution id.</b> A
    /// one-output transform passes on the execution id it received. A splitter or an entry step opens
    /// one per output. Two outputs under one id share one key and the second overwrites the first;
    /// <see cref="Guid.Empty"/> is refused outright.
    /// </para>
    /// <para>
    /// <b>An id minted in-process does not converge.</b> <see cref="NewExecutionId"/> is random, so a
    /// replay of the same input opens a different lineage under a different key. A crash between this
    /// call's write and its outcome then leaves the first key with no outcome naming it — an orphan
    /// nothing ever deletes — and a replay after the outcome runs the successor subtree twice. An author
    /// that wants convergence derives the id from what it received: the input's lineage, a record
    /// header, a stable business key. See limit 4 of the in-process post design.
    /// </para>
    /// <para>
    /// <b>No data is a branch too.</b> <paramref name="processedData"/> null or empty writes <c>""</c>
    /// under the branch's key, skips the output schema and reports Completed. It still counts as
    /// having sent a branch. An author that intends to pass data on must check that it is non-empty.
    /// </para>
    /// <para>
    /// <b>Never catch <see cref="PostSendException"/>.</b> It must propagate: the framework redelivers
    /// the dispatch and replays the author, which is a duplicate. Swallowing it, or rethrowing it as
    /// <see cref="FailedException"/>, reports a success as a failure. This system always takes the
    /// duplicate.
    /// </para>
    /// </summary>
    protected async Task SendToPostAsync(byte[]? processedData, Guid executionId, CancellationToken ct)
    {
        // Every output under Guid.Empty would derive one shared key. An author error, raised inside
        // the dispatch so the framework reports the step Failed and the log names the cause.
        if (executionId == Guid.Empty)
        {
            throw new ArgumentException(
                "SendToPostAsync needs a non-empty execution id: pass on the one the dispatch carries, "
                + "or open one per output (NewExecutionId, a record header, a business key).",
                nameof(executionId));
        }

        // NO DATA IS A LEGAL BRANCH (spec D4). Null and empty are the same thing.
        var data = processedData ?? [];

        var state = Current;
        var entryId = EntryIds.Branch(state.InputEntryId, state.WorkflowId, state.StepId, executionId);

        var branch = new ProcessedData(
            state.CorrelationId, executionId, state.WorkflowId, state.StepId, state.ProcessorId,
            entryId, data);

        try
        {
            // AWAITED, IN-PROCESS. The post queue carried the whole output in a message, which the
            // organisation's message-size cap no longer allows. The dispatch reclaims its input and
            // acks only after the author returns, so this call returning — branch in L2, outcome
            // confirmed — replaces the durable copy the queue used to hold.
            await state.Sink.FinishAsync(branch, ct).ConfigureAwait(false);

            // AFTER the call returns, never before it. The flag means "this branch's outcome is on its
            // way", which is the only thing that makes the orchestrator advance — a call that threw
            // must not mark one, or a dispatch whose every branch failed would look, to the check in
            // ProcessDispatchHandler, exactly like one that worked.
            state.MarkBranchSent();
        }
        catch (TransientSendException ex) when (ex is not OutputSchemaPendingException)
        {
            // ONLY the already-classified send fault is renamed. Naming it lets an author fanning out
            // see which branch was lost, and it stays a TransientSendException, so the consumer still
            // returns the dispatch to the queue. An unresolved output schema is already the requeue
            // type and is not a send failure. A store fault is not caught at all: it must reach
            // L2FaultClassifier raw, or the L2 gate would never close.
            throw new PostSendException(entryId, executionId, ex);
        }
    }

    /// <summary>
    /// A fresh, random execution id for a branch.
    /// <para>
    /// <b>It does not survive a replay.</b> A redelivered dispatch gets a different id, so its branch
    /// gets a different key: a crash between the branch's write and its outcome orphans the first key
    /// for good (no TTL, no sweeper), and a replay after the outcome runs the successor subtree twice.
    /// Use it only where that is acceptable; an author that wants a replay to converge derives the id
    /// from what it received instead. See <see cref="SendToPostAsync"/>.
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
