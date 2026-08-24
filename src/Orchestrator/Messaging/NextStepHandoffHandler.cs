using System.Diagnostics;
using System.Text.Json;
using BaseConsole.Core.Gating;
using BaseConsole.Core.Messaging;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;

namespace Orchestrator.Messaging;

/// <summary>
/// The post hop: gives one resolved successor its own input key and dispatches it.
/// <para>
/// <b>Write, then dispatch, and never the other way round.</b> The processor's pre handler reads an
/// absent input key as "an earlier attempt already finished this" and returns without running the
/// author — so a dispatch that overtakes its own blob is not a retryable race, it is a step that
/// silently never runs. The write going first is what makes that unrepresentable.
/// </para>
/// <para>
/// <b>Reads no L1, deliberately.</b> Both queues are shared, so this hop can land on a different
/// replica than the one that resolved the successor. Re-resolving here would mean the routing decision
/// came from one L1 snapshot and the payload from another, and a step dispatched with a payload from a
/// different version of its workflow leaves nothing behind to say so. Everything needed rides the
/// hand-off.
/// </para>
/// <para>
/// <b>A deterministic failure is reported as a failed step rather than parked.</b> Parking would stall
/// the workflow silently at a step that never started; reporting it puts a <see cref="StepOutcome"/>
/// back on the result queue, so the graph's own failure branch runs and — because the outcome names
/// the key just written — the blob is reclaimed by the pre hop rather than orphaned.
/// </para>
/// </summary>
internal sealed class NextStepHandoffHandler : IQueueMessageHandler
{
    private readonly IConnectionMultiplexer _redis;
    private readonly IQueueSender _sender;
    private readonly ILogger<NextStepHandoffHandler> _logger;

    public NextStepHandoffHandler(
        IConnectionMultiplexer redis,
        IQueueSender sender,
        ILogger<NextStepHandoffHandler> logger)
    {
        _redis  = redis ?? throw new ArgumentNullException(nameof(redis));
        _sender = sender ?? throw new ArgumentNullException(nameof(sender));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public string MessageType => MessageTypes.NextStepHandoff;

    public async Task HandleAsync(ReadOnlyMemory<byte> body, CancellationToken ct)
    {
        // Above the deserialization boundary there are no ids to report a failure with, so this one
        // shape parks rather than reporting: the fallback below cannot address an outcome it cannot
        // name.
        var h = JsonSerializer.Deserialize<NextStepHandoff>(body.Span, MessagingJson.Options)
                ?? throw new JsonException("next-step handoff deserialized to null");

        using (_logger.BeginScope(ExecutionLogScope.BuildScope(
                   h.ExecutionId, h.WorkflowId, h.StepId, h.ProcessorId, h.EntryId)))
        using (_logger.BeginScope(new Dictionary<string, object>
               {
                   [CorrelationKeys.LogScope] = CorrelationKeys.Render(h.CorrelationId),
               }))
        {
            await RunAsync(h, ct).ConfigureAwait(false);
        }
    }

    private async Task RunAsync(NextStepHandoff h, CancellationToken ct)
    {
        _logger.LogDebug("starting the next step");
        var started = Stopwatch.GetTimestamp();

        // Tracks whether the key exists yet, so the fallback can tell the pre hop which blob to
        // reclaim. Set immediately after the write rather than derived from h.EntryId, because a
        // failure between the two would otherwise send the orchestrator after a key nobody wrote.
        var wrote = false;

        try
        {
            if (h.EntryId != Guid.Empty)
            {
                _logger.LogDebug("writing the successor's input to L2");

                // When/flags named explicitly: StackExchange.Redis overloads a bare
                // (key, value, expiry) call between a keepTtl-bool overload and an Expiration-struct
                // one, and the compiler picks the former — a different method than the call site
                // reads as. The expiry is null on purpose; this blob is a live workflow's input and
                // an expiry would delete it mid-hand-off.
                await _redis.GetDatabase()
                    .StringSetAsync(
                        L2ProjectionKeys.ExecutionData(h.EntryId), h.Data, null, When.Always, CommandFlags.None)
                    .ConfigureAwait(false);

                wrote = true;
            }

            // EntryId rides through unchanged: the key just written is the one this step reads as its
            // input, and Guid.Empty passes through as the source-step sentinel the processor's pre
            // handler already implements.
            var dispatch = new ProcessDispatch(
                h.CorrelationId, h.ExecutionId, h.WorkflowId, h.StepId, h.ProcessorId, h.Payload, h.EntryId);

            // Registered BEFORE the send, so a queue whose very first dispatch fails is still
            // measured. That is the case where knowing the depth matters most.
            DispatchedQueues.Record(ProcessorQueues.Work(h.ProcessorId));

            await _sender
                .SendTransientAsync(
                    ProcessorQueues.Work(h.ProcessorId), MessageTypes.ProcessDispatch, dispatch, ct)
                .ConfigureAwait(false);

            _logger.LogInformation(
            "dispatched in {ElapsedMs}ms", (int)Stopwatch.GetElapsedTime(started).TotalMilliseconds);
        }
        catch (Exception ex) when (!IsRecoverable(ex))
        {
            // Deterministic. Redelivery cannot help and parking would stall the workflow at a step
            // that never started, with nothing downstream waiting on it and nothing to say why. The
            // outcome is reported against the step that failed to start, so the graph's own
            // failure-gated successors run.
            //
            // The message is logged, never sent: StepOutcome has no text field, and a serialization
            // fault's message quotes the fragment that broke — the same reason the processor keeps its
            // failure text local.
            _logger.LogError(ex, "could not start the step — reporting it failed");

            // The key just written, so the pre hop reclaims it; Guid.Empty when the failure came
            // before or during the write and there is nothing to reclaim.
            var entryId = wrote ? h.EntryId : Guid.Empty;

            try
            {
                await _sender.SendTransientAsync(
                        OrchestratorQueues.Result,
                        MessageTypes.StepOutcome,
                        new StepOutcome(
                            h.CorrelationId, h.ExecutionId, h.WorkflowId, h.StepId, h.ProcessorId,
                            entryId, StepResult.Failed),
                        ct)
                    .ConfigureAwait(false);
            }
            catch (Exception report) when (!IsRecoverable(report) && wrote)
            {
                // THE ONE PARK PATH THAT CAN LEAK. Everything else here either acks — handing the
                // key on to the pre hop, which reclaims it — or requeues, where the redelivery
                // rewrites the same key. This arm is reached only when the outcome that WOULD have
                // named the key cannot be sent, and deterministically so: nothing downstream will
                // ever learn the key exists, the message goes to the dead-letter exchange, and the
                // blob is orphaned for good.
                //
                // Reclaimed before rethrowing, for the same reason and with the same accepted cost
                // as the L1-miss park in StepOutcomeHandler: the dead-lettered message can no longer
                // be replayed by hand, and that is the price of not leaking. The filter requires
                // `wrote`, because with no key written there is nothing to reclaim and a delete
                // would only add a second way for this arm to fail.
                _logger.LogError(
                    report, "could not report the failed step either — reclaiming its input and parking");

                await _redis.GetDatabase()
                    .KeyDeleteAsync(L2ProjectionKeys.ExecutionData(h.EntryId))
                    .ConfigureAwait(false);

                throw;
            }
        }
    }

    /// <summary>
    /// Whether redelivering this hand-off could succeed where this attempt did not.
    /// <para>
    /// The two recoverable shapes are the two the consumer's own classifier acts on: a transport fault
    /// on a send, and the projection store being unreachable. Letting those escape hands the decision
    /// to <see cref="DeliveryClassifier"/>, which returns the delivery — and, for a store fault, closes
    /// the gate so the whole consumer pauses instead of burning a redelivery per message for the
    /// length of the outage.
    /// </para>
    /// <para>
    /// <b>Everything else is deterministic by default, and the direction of that default is
    /// deliberate.</b> Misclassifying a transient as deterministic reports one step failed that would
    /// have succeeded on a retry — visible in the workflow's own outcome. Misclassifying the other way
    /// requeues a message that fails identically every time, forever, and the workflow never ends.
    /// </para>
    /// </summary>
    private static bool IsRecoverable(Exception ex) =>
        ex is TransientSendException || L2FaultClassifier.IsTransient(ex);
}
