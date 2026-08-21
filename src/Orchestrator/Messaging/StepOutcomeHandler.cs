using System.Text.Json;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
using Orchestrator.Dispatch;
using Orchestrator.L1;
using StackExchange.Redis;

namespace Orchestrator.Messaging;

/// <summary>
/// The pre hop: takes one step's outcome, decides which successors it lets through, and hands each of
/// them a copy of the finished step's blob.
/// <para>
/// <b>Read once, hand off N times, reclaim last.</b> The blob is read before any hand-off is sent,
/// because the alternative — each successor reading the shared key for itself — is the multi-successor
/// hazard both processor handlers document and refuse to defend against: the first successor's pre hop
/// reclaims the key when its author returns, and every other successor finds it absent and silently
/// does nothing. Copying it per successor under a key of that successor's own is what closes that, and
/// it is why this hop exists at all.
/// </para>
/// <para>
/// <b>The reclaim is the last statement and is not inside any branch.</b> Every path that reaches the
/// end of this handler has acknowledged the outcome as business-final, and a business-final ack that
/// skips the delete leaks the blob permanently — <c>data:</c> keys carry no TTL and no sweeper covers
/// them. That is not hypothetical: the prior implementation returned early on the terminal and
/// no-successor paths, which sit before the reclaim, and left the store holding one orphan per
/// terminal step of every run.
/// </para>
/// <para>
/// <b>Not gated on leadership.</b> Leadership fences cron fires, where two replicas firing one
/// schedule double-dispatch. Exactly one outcome exists per step that ran, so whichever replica takes
/// it does the whole hand-off; gating here would idle every follower and make the leader the
/// deployment's throughput ceiling.
/// </para>
/// </summary>
internal sealed class StepOutcomeHandler : IQueueMessageHandler
{
    private readonly WorkflowL1Store _store;
    private readonly IConnectionMultiplexer _redis;
    private readonly IQueueSender _sender;
    private readonly ILogger<StepOutcomeHandler> _logger;

    public StepOutcomeHandler(
        WorkflowL1Store store,
        IConnectionMultiplexer redis,
        IQueueSender sender,
        ILogger<StepOutcomeHandler> logger)
    {
        _store  = store ?? throw new ArgumentNullException(nameof(store));
        _redis  = redis ?? throw new ArgumentNullException(nameof(redis));
        _sender = sender ?? throw new ArgumentNullException(nameof(sender));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public string MessageType => MessageTypes.StepOutcome;

    public async Task HandleAsync(ReadOnlyMemory<byte> body, CancellationToken ct)
    {
        // Above the deserialization boundary: a body that will not parse carries no ids to report a
        // failure with, so throwing is the only honest option — the consumer parks it and the bytes
        // survive where someone can look at them.
        var m = JsonSerializer.Deserialize<StepOutcome>(body.Span, MessagingJson.Options)
                ?? throw new JsonException("step outcome deserialized to null");

        using (_logger.BeginScope(ExecutionLogScope.BuildScope(
                   m.ExecutionId, m.WorkflowId, m.StepId, m.ProcessorId, m.EntryId)))
        using (_logger.BeginScope(new Dictionary<string, object>
               {
                   [CorrelationKeys.LogScope] = CorrelationKeys.Render(m.CorrelationId),
               }))
        {
            await RunAsync(m, ct).ConfigureAwait(false);
        }
    }

    private async Task RunAsync(StepOutcome m, CancellationToken ct)
    {
        // L1 is a per-replica mirror of L2 and this queue is shared, so a miss here has two readings:
        // the workflow was stopped while this step was still running, or this replica has not yet
        // drained the start announcement for it. Parking treats both as faults to look at rather than
        // guessing which one it is, and keeps the message recoverable from the dead-letter queue.
        // Consumption is admitted only after the first hydration pass completes, which is what makes
        // the second reading narrow rather than routine.
        if (!_store.TryGet(m.WorkflowId, out var entry) ||
            !entry.Steps.TryGetValue(m.StepId, out var completed))
        {
            throw new InvalidOperationException(
                "the outcome names a workflow or step this replica does not hold in L1");
        }

        var selection = StepAdvancement.SelectNext(m.Result, completed, entry.Steps);

        // Guid.Empty is not a key. It arrives on three shapes the processor produces — a failed source
        // step, an output that failed its schema, and a cancellation of a source step — and it means
        // there is no blob: nothing to read, nothing to copy, nothing to reclaim. The successors are
        // handed empty data and dispatched with the same sentinel, which the processor's pre handler
        // already reads as "no upstream input, the author produces its own".
        var data = m.EntryId == Guid.Empty
            ? []
            : await ReadAsync(m.EntryId).ConfigureAwait(false);

        // One hand-off per matched successor, each with its own freshly minted key. The mint is
        // NewGuid, matching the processor: a redelivery of this outcome mints new keys and hands the
        // successors off a second time, so a step whose ack was lost advances twice. The reclaim below
        // is what keeps that narrow — the redelivery finds the source blob gone and parks instead.
        foreach (var next in selection.Matches)
        {
            // No blob means no key: the successor is dispatched as a source step rather than pointed
            // at an empty one. Minting an id here would have the post hop write a zero-length value
            // that the successor then reads and ignores.
            var entryId = data.Length == 0 ? Guid.Empty : Guid.NewGuid();

            var handoff = new NextStepHandoff(
                m.CorrelationId, m.ExecutionId, m.WorkflowId,
                next.StepId, next.ProcessorId, next.Payload, entryId, data);

            // A send fault is classified transient, so the whole outcome is returned to the queue and
            // every hand-off is re-sent. That is the reason the reclaim is last: the source blob is
            // still there for the replay to read.
            await _sender
                .SendTransientAsync(OrchestratorQueues.ResultPost, MessageTypes.NextStepHandoff, handoff, ct)
                .ConfigureAwait(false);

            _logger.LogInformation(
                "handed off to {NextStepId} on {NextProcessorId} with {NextEntryId}",
                next.StepId, next.ProcessorId, entryId);
        }

        // A successor id the step map does not hold. Logged and skipped rather than thrown: throwing
        // would park an outcome whose OTHER successors have already been handed off, so the workflow
        // would advance down some branches and be parked for the rest, with the reclaim below skipped
        // as well. The edge is a defect in the projected graph, not in this message.
        foreach (var id in selection.Dangling)
        {
            _logger.LogWarning("successor {NextStepId} is not in this workflow's step set — skipping it", id);
        }

        if (selection.Matches.Count == 0)
        {
            _logger.LogInformation(
                "no successor accepts {Result} — the branch ends here", m.Result);
        }

        // Unconditional, and last. See the type remarks: every path reaching here has acked the
        // outcome as final, and a store fault must propagate so the classifier trips the gate and
        // requeues rather than acknowledging a hand-off whose source was never reclaimed.
        if (m.EntryId != Guid.Empty)
        {
            await _redis.GetDatabase()
                .KeyDeleteAsync(L2ProjectionKeys.ExecutionData(m.EntryId))
                .ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Reads the finished step's blob.
    /// <para>
    /// <b>An absent key is refused rather than treated as a duplicate delivery</b>, which is the
    /// opposite of the choice the processor's pre handler makes on the same shape. The reasoning
    /// differs because the evidence does: a processor holds a dispatch it can prove it already
    /// finished, since its own reclaim is what removed the key. Here the key could equally have been
    /// removed by a previous attempt at this outcome or never written at all, and the second is a real
    /// defect — a step reporting a key it did not produce. Parking is loud and recoverable; acking
    /// would let the second case pass as the first, forever.
    /// </para>
    /// <para>
    /// <b>The cost is a redelivery whose predecessor got all the way through the reclaim.</b> The
    /// delete and the acknowledgement are not atomic, so a channel lost between them parks an outcome
    /// that was in fact handled. It lands in the dead-letter queue with its ids intact rather than
    /// being lost, and the hand-offs it already sent are unaffected.
    /// </para>
    /// </summary>
    private async Task<byte[]> ReadAsync(Guid entryId)
    {
        // A store fault propagates: the consumer classifies it, closes the gate and returns the
        // delivery. Catching it here would acknowledge an outcome that was never acted on.
        var raw = await _redis.GetDatabase()
            .StringGetAsync(L2ProjectionKeys.ExecutionData(entryId))
            .ConfigureAwait(false);

        if (raw.IsNullOrEmpty)
        {
            throw new InvalidOperationException(
                "the outcome names an execution blob the store does not hold");
        }

        return (byte[])raw!;
    }
}
