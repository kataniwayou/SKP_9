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

        using (_logger.BeginScope(ExecutionLogScope.BuildState(d)))
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
        // ProcessorId on EVERY outbound message comes from OUR OWN identity, never from the inbound
        // one. The dispatch was addressed to this processor's queue, so we ARE the processor it
        // names — echoing its field back is the only way the two could ever disagree, and a result
        // attributed to another processor's id lands in their lineage. Stamping from self makes that
        // unrepresentable, which is why this design carries no provenance guard anywhere: a check
        // against a condition that cannot arise reads as a live defence, cannot be tested, and drifts.
        //
        // Resolved ONCE, above every early return, so the schema-failure path is covered too.
        //
        // NOTHING GATES CONSUMPTION ON HEALTH TODAY — this used to claim the work queue is bound only
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
        var self = identity.Id;

        // The pair ProcessorIdentity documents: a NULL schema id means the role does not apply, while
        // a non-null id whose definition is still null means Loop B has not resolved it yet. Only the
        // second is a fault. Proceeding would hand TryValidate a null definition, which returns true
        // by contract, and the step would run with the input schema silently not applied — a security
        // control skipped with nothing logged to say so. Parking is the same disposition the identity
        // guard above chooses, and the direction spec 8.1 gives every ambiguous case; reporting a
        // StepFailed instead would mark a workflow failed over a condition that resolves itself
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
                // THIS DEPENDS ON AN ASSUMPTION THE WIRING DOES NOT ENFORCE: that at most one dispatch
                // per entry key is in flight across the whole deployment. Under multiple replicas —
                // which ProcessorLivenessWriter's per-instance keys imply is intended — a second
                // concurrent attempt could read this key before the first one's reclaim runs and then
                // re-run the author. That re-run is not silent data loss: SendToPostAsync derives its
                // message ids from data the two attempts share, so the duplicate branches rewrite the
                // same post-handler keys rather than create new ones. The residual cost is a duplicate
                // run of the author's own code, which this design already treats as an acceptable replay
                // cost everywhere else.
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
            await SendAsync(new StepFailed(d.WorkflowId, d.StepId, self)
            {
                CorrelationId = d.CorrelationId,
                ExecutionId   = d.ExecutionId,
                ErrorMessage  = string.Join("; ", errors),
            }, MessageTypes.StepFailed, ct).ConfigureAwait(false);

            _logger.LogInformation("input failed its schema — reported failed");
            return;
        }

        _processor.BeginDispatch(new DispatchState(
            _sender, d.WorkflowId, d.StepId, self, d.CorrelationId, d.EntryId));

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
            await SendAsync(new StepFailed(d.WorkflowId, d.StepId, self)
            {
                CorrelationId = d.CorrelationId,
                ExecutionId   = d.ExecutionId,
                ErrorMessage  = ex.Message,   // author-authored, so verbatim is safe
            }, MessageTypes.StepFailed, ct).ConfigureAwait(false);
        }
        catch (CancelledException ex)
        {
            await SendAsync(new StepCancelled(d.WorkflowId, d.StepId, self)
            {
                CorrelationId       = d.CorrelationId,
                ExecutionId         = d.ExecutionId,
                CancellationMessage = ex.Message,
            }, MessageTypes.StepCancelled, ct).ConfigureAwait(false);
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
            // The message is deliberately a constant. A deserialize JsonException quotes the offending
            // fragment of the payload, and this text reaches the orchestrator's projections.
            _logger.LogWarning(ex, "the transform faulted — reporting the step failed");

            await SendAsync(new StepFailed(d.WorkflowId, d.StepId, self)
            {
                CorrelationId = d.CorrelationId,
                ExecutionId   = d.ExecutionId,
                ErrorMessage  = "the processor faulted",
            }, MessageTypes.StepFailed, ct).ConfigureAwait(false);
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
        // catch and reported as a StepFailed that never happened. The replay is safe — the author
        // re-runs and its branches carry the same derived message ids, so the post handler rewrites
        // identical bytes.
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
    /// Sends a result, classifying a broker failure as transient so the delivery is returned to the
    /// queue rather than parked — the step's outcome is known and must not be lost to a blip.
    /// </summary>
    private Task SendAsync<T>(T result, string type, CancellationToken ct)
        => _sender.SendTransientAsync(OrchestratorQueues.Result, type, result, ct);
}
