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
/// Runs one step: read the input, validate it, hand it to the author.
/// <para>
/// <b>This handler never mutates the projection store.</b> No write, no delete. That is what makes
/// every failure below safe to retry: whatever goes wrong, the input key is exactly as it was found,
/// so the redelivery replays from the same starting state. Reclaiming the input belongs to the post
/// handler, which owns it along with everything else keyed by the branch's message id.
/// </para>
/// <para>
/// Two rejected alternatives are worth recording. Deleting the input <i>before</i> the transform
/// leaves a redelivery reading an absent key, which returns without processing — a silently lost
/// step. Deleting it <i>after</i> a successful branch send means a failed delete requeues the
/// dispatch, the transform runs again, and the workflow forks; a store blip is precisely the fault
/// this design expects, so that would make forking routine.
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
                // Read as "a post handler already reclaimed this key", and returning is right for that
                // reading: reporting a failure would overwrite a finished workflow's outcome.
                //
                // THIS DEPENDS ON AN ASSUMPTION THE WIRING DOES NOT ENFORCE: that at most one dispatch
                // per entry key is in flight across the whole deployment. Under multiple replicas —
                // which ProcessorLivenessWriter's per-instance keys imply is intended — the absent key
                // has a second reading. Replica A fans out, branch 1 sends, branch 2's send fails and
                // the dispatch is requeued; replica B consumes branch 1's ProcessedData and deletes
                // data:{entryId}; the redelivered dispatch then finds the key absent, reads it as
                // completion, and returns. Branch 2 is never sent and the step stalls forever with no
                // error anywhere.
                //
                // Not fixed here on purpose. Distinguishing the two readings needs state this handler
                // does not have, and guessing the other way — running on an absent key — would fork
                // finished workflows, which is worse. The stuck-step reaper is what closes it; see the
                // known gaps in the execution-path plan.
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
        try
        {
            await _processor.ExecuteAsync(data, d.Payload, d.ExecutionId, ct).ConfigureAwait(false);
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
    }

    /// <summary>
    /// Sends a result, classifying a broker failure as transient so the delivery is returned to the
    /// queue rather than parked — the step's outcome is known and must not be lost to a blip.
    /// </summary>
    private Task SendAsync<T>(T result, string type, CancellationToken ct)
        => _sender.SendTransientAsync(OrchestratorQueues.Result, type, result, ct);
}
