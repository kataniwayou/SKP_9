using System.Text.Json;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Validation;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;

namespace BaseProcessor.Core.Processing;

/// <summary>
/// Runs one step: read the input, validate it, hand it to the author, then reclaim the input once the
/// author has returned.
/// <para>
/// <b>This handler writes nothing to the projection store — the only mutation is the final delete,
/// and it runs at most once.</b> Every failure before the author returns is safe to retry: whatever
/// goes wrong, the input key is exactly as it was found, so the redelivery replays from the same
/// starting state. The reclaim itself sits outside the failure paths, gated on the author having
/// actually run to completion; see the comment beside it for why.
/// </para>
/// </summary>
internal sealed class ProcessDispatchHandler : IQueueMessageHandler
{
    private readonly IConnectionMultiplexer _redis;
    private readonly IQueueSender _sender;
    private readonly IProcessorContext _context;
    private readonly BaseProcessor _processor;
    private readonly ILogger<ProcessDispatchHandler> _logger;

    public ProcessDispatchHandler(
        IConnectionMultiplexer redis,
        IQueueSender sender,
        IProcessorContext context,
        BaseProcessor processor,
        ILogger<ProcessDispatchHandler> logger)
    {
        _redis     = redis ?? throw new ArgumentNullException(nameof(redis));
        _sender    = sender ?? throw new ArgumentNullException(nameof(sender));
        _context   = context ?? throw new ArgumentNullException(nameof(context));
        _processor = processor ?? throw new ArgumentNullException(nameof(processor));
        _logger    = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public string MessageType => MessageTypes.ProcessDispatch;

    public async Task HandleAsync(ReadOnlyMemory<byte> body, CancellationToken ct)
    {
        // Above the deserialization boundary. A body that will not parse carries no ids to report a
        // failure with, so throwing is the only honest option — the consumer parks it and the bytes
        // survive where someone can look at them.
        var d = JsonSerializer.Deserialize<ProcessDispatch>(body.Span, MessagingJson.Options)
                ?? throw new JsonException("dispatch deserialized to null");

        using (_logger.BeginScope(ExecutionLogScope.BuildScope(d)))
        using (_logger.BeginScope(new Dictionary<string, object>
               {
                   [CorrelationKeys.LogScope] = CorrelationKeys.Render(d.CorrelationId),
               }))
        {
            await RunAsync(d, ct).ConfigureAwait(false);
        }
    }

    private async Task RunAsync(ProcessDispatch d, CancellationToken ct)
    {
        // ProcessorId is passed through, exactly like WorkflowId and StepId. It is a routing and
        // tracing id, not a claim this handler has to verify: the orchestrator reads it off L1, uses it
        // to address this queue, and stamps the same value on the body — one expression, both uses — so
        // a dispatch that reached us names us by construction.
        //
        // This used to be overwritten with the resolved identity's own id. That defended a state that
        // cannot arise, which is the thing this design refuses everywhere else: a check against a
        // condition that cannot occur reads as a live defence, cannot be tested, and drifts. It was
        // also only ever partial — anything able to forge this field can forge WorkflowId and StepId
        // too, and nothing overwrites those.
        //
        // IDENTITY IS STILL RESOLVED HERE, for the input schema below, and NOTHING GATES CONSUMPTION
        // ON HEALTH TODAY — this used to claim the work queue is bound only
        // after the processor reaches Healthy, and that is not true of the wiring. GatedQueueConsumer
        // is a BackgroundService that starts consuming as soon as the L2 gate opens, and
        // IProcessorContext.IsHealthy is read by nothing but the liveness heartbeat and a readiness
        // check. So a dispatch CAN arrive while the startup loops are still running. Gating
        // consumption on health is the proper fix and is recorded as a known gap in the execution-path
        // plan; until it lands, both guards below park the message rather than proceed. Loud is right:
        // parking preserves the message for inspection and it is recoverable by hand from the DLQ.
        var identity = _context.Identity
            ?? throw new InvalidOperationException(
                "A dispatch was consumed before identity resolved — the queue must not be bound until then.");

        // The pair ProcessorIdentity documents: a NULL schema id means the role does not apply, while
        // a non-null id whose definition is still null means Loop B has not resolved it yet. Only the
        // second is a fault. Proceeding would hand TryValidate a null definition, which returns true
        // by contract, and the step would run with the input schema silently not applied — a security
        // control skipped with nothing logged to say so. Parking is the same disposition the identity
        // guard above chooses, and the direction spec 8.1 gives every ambiguous case; reporting a
        // a failed outcome instead would mark a workflow failed over a condition that resolves itself
        // seconds later.
        if (identity.InputSchemaId is { } inputSchemaId && identity.InputDefinition is null)
        {
            throw new InvalidOperationException(
                $"Input schema {inputSchemaId:D} has not resolved yet, so the input cannot be "
                + "validated — the work queue must not be bound before the processor reaches Healthy.");
        }

        var isSource = d.EntryId == Guid.Empty;

        byte[] data;
        if (isSource)
        {
            // No upstream input. The author produces its own, and there is no key to read or reclaim.
            data = [];
        }
        else
        {
            // A store fault propagates: the consumer classifies it, closes the gate and returns the
            // delivery. Catching it here would acknowledge a step that never ran.
            var raw = await _redis.GetDatabase()
                .StringGetAsync(L2ProjectionKeys.ExecutionData(d.EntryId))
                .ConfigureAwait(false);

            if (raw.IsNullOrEmpty)
            {
                // Read as "an earlier attempt at this dispatch already reclaimed this key", and
                // returning is right for that reading: reporting a failure would overwrite a finished
                // workflow's outcome. The reclaim runs only once the WHOLE author has returned — see the
                // reclaim at the end of RunAsync — so an absent key never means a fan-out was caught
                // mid-flight with some branches sent and others lost; that state cannot arise.
                //
                // THIS BRANCH IS NOW THE PRIMARY IDEMPOTENCE MECHANISM, not a safety net. While branch
                // ids were derived from the dispatch, a re-run of the author converged — the same seeds
                // produced the same keys and the writes were rewrites. Ids are minted with NewGuid now
                // (see SendToPostAsync), so a re-run produces DIFFERENT keys and a second outcome, and
                // the successor subtree runs twice. Returning here is what stops that, which makes the
                // ordering above load-bearing: the reclaim runs only once the WHOLE author has returned,
                // so an absent key can be read as "already done" and never as "caught mid-fan-out".
                //
                // Two reachable cases sit outside its reach, and they are the accepted cost of the
                // NewGuid decision rather than gaps to be closed here. The reclaim below can itself fail
                // — Redis reachable for the read and not for the delete — leaving the key present for a
                // redelivery that then re-runs the author. And a source step has no key at all, so this
                // branch never executes for one, and a lost acknowledgement alone is enough to re-run it.
                // Neither loses data and neither leaks: the orchestrator reclaims every output blob it
                // relocates. What they cost is a second run of the author's own code, which is free for a
                // pure transform and is not for a step with side effects.
                //
                // A SEPARATE CASE THIS DOES NOT COVER: several successor steps dispatched against the
                // one shared entry key.
                //
                // Each would carry its own ProcessDispatch message rather than a
                // branch raised from inside a single author invocation. A step with more than one
                // successor still hands every successor the same EntryId, and the first successor's own
                // RunAsync reclaims that key once ITS author returns. Every other successor then reads
                // absent here — not a redelivery of anything, but a step that has not run yet, finding a
                // key a different step already consumed. Returning in that case means the successor's
                // author never runs at all: a silent loss, not a safe duplicate, because nothing
                // downstream reports it and nothing retries it. Preventing this is the orchestrator's
                // job — copying the blob into one key per successor under derived ids before dispatch,
                // or refcounting the shared key so only the last reader deletes it — and nothing in this
                // assembly defends against it. That is a decision, not an oversight: this handler trusts
                // EntryId to name a key it alone is entitled to delete, and multi-successor fan-out is
                // the one case where that trust does not hold until the orchestrator exists to make it
                // hold.
                //
                // With execution blobs carrying no TTL, this branch now has exactly two readings, not
                // three: reclaimed, or never written. It can no longer mean expired.
                _logger.LogInformation("entry absent — treating as a duplicate delivery");
                return;
            }

            data = (byte[])raw!;
        }

        // Skipped for a source step as a branch decision, not as a side effect of a source processor
        // having no input schema. A null definition skips validation anyway, so this works by accident
        // today — but a source step that did carry one would have empty bytes parsed, throw, and fail a
        // step that was never wrong.
        if (!isSource
            && !ProcessorJsonSchemaValidator.TryValidate(identity.InputDefinition, data, out var errors))
        {
            // Logged here because it is no longer carried anywhere else. StepOutcome has no text
            // field, so this line is the only record of WHY the step failed — and the validator's
            // output can quote payload fragments, which is precisely why it belongs in this
            // processor's own logs rather than on the wire and in the orchestrator's projections.
            _logger.LogInformation(
                "input failed its schema — reported failed: {SchemaErrors}", string.Join("; ", errors));

            await SendAsync(Failure(d, StepResult.Failed), ct).ConfigureAwait(false);
            return;
        }

        _processor.BeginDispatch(new DispatchState(
            _sender, d.CorrelationId, d.WorkflowId, d.StepId, d.ProcessorId));

        // Set only on the normal path. Every catch below leaves it false, which is what keeps a failed
        // or cancelled step's input intact for the orchestrator to deal with.
        var ran = false;
        try
        {
            await _processor.ExecuteAsync(data, d.Payload, d.ExecutionId, ct).ConfigureAwait(false);
            ran = true;
        }
        catch (FailedException ex)
        {
            // The author's own text, and this line is now the only place it survives — StepOutcome
            // carries no message. Author-authored, so verbatim is safe here exactly as it once was on
            // the wire.
            _logger.LogInformation("the author reported the step failed: {Reason}", ex.Message);

            await SendAsync(Failure(d, StepResult.Failed), ct).ConfigureAwait(false);
        }
        catch (CancelledException ex)
        {
            _logger.LogInformation("the author cancelled the branch: {Reason}", ex.Message);

            await SendAsync(Failure(d, StepResult.Cancelled), ct).ConfigureAwait(false);
        }
        catch (TransientSendException)
        {
            // MUST sit above the general catch. A branch that could not be sent is recoverable by
            // redelivery; reporting it as a failed step would acknowledge the dispatch and lose the
            // branch permanently while recording a business outcome that never happened.
            throw;
        }
        // The filter turns on WHOSE cancellation it is, not on the exception type. Our consumer passes
        // CancellationToken.None deliberately, so ct is never cancelled in production — which means an
        // OperationCanceledException arriving with an un-cancelled ct came from the author's own code
        // or a library it called. HttpClient surfaces a request timeout as TaskCanceledException, a
        // subclass of this one, and that is the commonest transient fault an author will ever hit;
        // excluding it here would PARK the dispatch with no StepFailed and no retry. When ct IS
        // cancelled the process is stopping, the step's outcome is genuinely unknown, and the
        // exception must escape so the delivery is not acknowledged with a fabricated outcome.
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            // The exception goes to the log and nowhere else. It always had to: a deserialize
            // JsonException quotes the offending fragment of the payload, and this used to be paired
            // with a fixed constant on the wire to keep that out of the orchestrator's projections.
            // With no text field on StepOutcome at all, the constant is gone and the pairing is
            // structural rather than a rule anyone has to remember.
            _logger.LogWarning(ex, "the transform faulted — reporting the step failed");

            await SendAsync(Failure(d, StepResult.Failed), ct).ConfigureAwait(false);
        }
        finally
        {
            _processor.EndDispatch();
        }

        // The input is reclaimed HERE rather than in the post handler, and only after the author's
        // transform returned normally. A fan-out sends N branches from inside one ProcessAsync; the
        // return is the only signal that all N went out. Reclaiming per branch instead would delete
        // the input after branch 1, so a failed branch-2 send would requeue a dispatch whose input is
        // already gone — the redelivery would read an absent key, take the duplicate-delivery branch,
        // and lose branch 2 silently.
        //
        // Outside the catch chain on purpose: a store fault on this delete must propagate so the L2
        // classifier trips the gate and requeues. Inside the try it would be caught by the general
        // catch and reported as a failed step that never happened.
        //
        // A DELETE THAT FAILS IS THE ONE PATH THAT COSTS SOMETHING, and it is the price of minting
        // branch ids with NewGuid. The redelivery finds this key still present, re-runs the author,
        // and its branches carry FRESH ids — so the post handler writes new blobs rather than
        // rewriting the ones the first attempt wrote, and the successor subtree runs twice. Nothing is
        // lost and nothing leaks (the orchestrator reclaims every blob it relocates), but the author's
        // own code does run again. See SendToPostAsync for why that trade was taken and how to reverse
        // it.
        //
        // Skipped for a source step, which produced its own input and has no key. The author still
        // ran; only the delete is skipped.
        if (ran && d.EntryId != Guid.Empty)
        {
            await _redis.GetDatabase()
                .KeyDeleteAsync(L2ProjectionKeys.ExecutionData(d.EntryId))
                .ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Builds the outcome for a step that produced no output.
    /// <para>
    /// <b>EntryId is the dispatch's own — the step's INPUT — and that is the whole point of it.</b>
    /// None of these paths sets <c>ran</c>, so the reclaim at the end of <see cref="RunAsync"/> is
    /// skipped and that key is still in the store. Execution blobs have no TTL and no sweeper covers
    /// them, so if this outcome did not name the key, nothing anywhere ever would and every failed step
    /// would leak its input permanently. A source step reports <see cref="Guid.Empty"/> here, which is
    /// correct: it read no key, so there is none to reclaim.
    /// </para>
    /// </summary>
    private static StepOutcome Failure(ProcessDispatch d, StepResult result) =>
        new(d.CorrelationId, d.ExecutionId, d.WorkflowId, d.StepId, d.ProcessorId, d.EntryId, result);

    /// <summary>
    /// Sends an outcome, classifying a broker failure as transient so the delivery is returned to the
    /// queue rather than parked — the step's outcome is known and must not be lost to a blip.
    /// </summary>
    private Task SendAsync(StepOutcome outcome, CancellationToken ct)
        => _sender.SendTransientAsync(OrchestratorQueues.Result, MessageTypes.StepOutcome, outcome, ct);
}
