using System.Diagnostics;
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

    /// <summary>
    /// Which half of the L1 lookup missed, or null when the outcome resolves.
    /// <para>
    /// <b>Two conditions, two different incidents, and they must not share a sentence.</b> A missing
    /// WORKFLOW means this replica never activated it or has dropped it — a control-plane problem. A
    /// missing STEP means the replica holds a definition that disagrees with the outcome in flight —
    /// a versioning problem. The fixes have nothing in common.
    /// </para>
    /// <para>
    /// <b>This is here because the undifferentiated message cost an investigation.</b> Six outcomes
    /// were found dead-lettered on the live stack, every one of them carrying "the outcome names a
    /// workflow or step this replica does not hold in L1". Separating the readings took correlating
    /// dead-letter x-death headers against restart records across two days, and even then it did not
    /// settle which half had failed — because nothing had recorded it. The step count comes along
    /// because a replica holding the wrong number of steps is a versioning problem visible at a
    /// glance, and the ids come along because a parked message is recoverable only by hand and the
    /// ids are the only thing pairing a queued body to the line that refused it.
    /// </para>
    /// </summary>
    internal static string? DescribeL1Miss(WorkflowL1Store store, Guid workflowId, Guid stepId)
    {
        ArgumentNullException.ThrowIfNull(store);

        if (!store.TryGetIncludingStopped(workflowId, out var entry))
        {
            return $"this replica does not hold workflow {workflowId} in L1, "
                 + $"so the outcome for step {stepId} cannot be advanced";
        }

        if (!entry.Steps.ContainsKey(stepId))
        {
            return $"this replica holds workflow {workflowId} with {entry.Steps.Count} step(s) "
                 + $"but that definition does not carry step {stepId}";
        }

        return null;
    }

    private async Task RunAsync(StepOutcome m, CancellationToken ct)
    {
        _logger.LogDebug("advancing the graph on a {Result} outcome", m.Result);
        var started = Stopwatch.GetTimestamp();

        // L1 is a per-replica mirror of L2 and this queue is shared, so a miss here had two readings:
        // the workflow was stopped while this step was still running, or this replica has not yet
        // drained the start announcement for it. Parking treats a miss as a fault to look at rather
        // than guessing which one it is, and keeps the message recoverable from the dead-letter queue.
        // Consumption is admitted only after the first hydration pass completes, which is what makes
        // the second reading narrow rather than routine.
        //
        // MEASURED ON THE LIVE STACK, and it did not match either reading cleanly. Six outcomes were
        // found dead-lettered across four incidents over two days. In all four, the parking followed a
        // broker reconnect or process restart by 66-171 seconds. In none of them was there any stop
        // record -- no removal line, no "stop applied" -- in the preceding 25 minutes, so the stop
        // reading was unsupported despite being written here as the commonest. And in the clearest
        // incident all three replicas logged "activated workflow" 107 seconds BEFORE the parking,
        // which rules out the announcement reading for that one.
        //
        // THE FIRST READING IS NOW DESIGNED OUT rather than merely diagnosed: a stop marks the L1
        // entry instead of removing it (see ApplyStopHandler), so a workflow stopped mid-flight still
        // resolves here for a full round trip. What survives is the second reading, plus the case the
        // measurements above actually point at -- a restart, after which nothing rebuilds the marks,
        // because L2 no longer holds a stopped workflow for hydration to find. An outcome arriving in
        // that window still parks, and DescribeL1Miss is still what says which lookup missed.
        // INCLUDING STOPPED, and that is the point of the lookup split. A workflow stopped while this
        // step was running keeps its L1 entry, marked, for a full round trip — so the outcome resolves
        // here and its run drains instead of being parked. That reading is no longer a reason to reach
        // the branch below at all, which narrows what reaching it means: this replica has not drained
        // the start announcement, or it holds a definition that disagrees with the outcome in flight.
        if (!_store.TryGetIncludingStopped(m.WorkflowId, out var entry) ||
            !entry.Steps.TryGetValue(m.StepId, out var completed))
        {
            // RECLAIM BEFORE PARKING. A park is a nack, but it is a nack with requeue:false — the
            // message leaves for the dead-letter exchange and never comes back, so the blob is
            // orphaned exactly as it would be by an ack. data: keys carry no TTL and no sweeper
            // covers them, so every outcome that lands here without this leaks one blob permanently.
            // This used to be the routine case rather than the rare one -- a stop removed the
            // workflow from L1 and every outcome still on the wire arrived here, one leaked blob per
            // in-flight step. Marking instead of removing closed that; the reclaim stays because the
            // readings that remain leak exactly the same way, just less often.
            //
            // This execution is over either way. The next scheduled fire will most likely meet the
            // same condition and park too, which is the loud signal parking exists to give — but it
            // will not also leak, which is the difference that matters.
            //
            // The cost is deliberate: the dead-lettered message names a key that no longer exists,
            // so it can no longer be replayed by hand. That trade is taken knowingly. The blob is
            // reclaimed for the same reason it is reclaimed on the acked path.
            await ReclaimAsync(m.EntryId).ConfigureAwait(false);

            // Described only here, on the cold path. The condition above stays a short-circuited pair
            // of dictionary hits because it is the hot path -- every outcome from every processor
            // runs it -- and re-reading the store to build a sentence is affordable exactly once, in
            // the branch that is about to throw the message away.
            throw new InvalidOperationException(DescribeL1Miss(_store, m.WorkflowId, m.StepId));
        }

        // The record that the grace period did its job. Without it, "stopped mid-flight and drained
        // cleanly" and "was never stopped at all" produce identical logs, so the only visible evidence
        // the mark was ever load-bearing would be the absence of a parked message -- which is not
        // evidence anyone can search for. Information rather than Debug for the same reason the
        // activation line is: it fires once per stopped run, not once per anything hot.
        if (entry.DeletedAt is { } stoppedAt)
        {
            _logger.LogInformation(
                "the workflow was stopped at {StoppedAt}; resolving this outcome anyway so the run drains",
                stoppedAt);
        }

        // The opening half of a run's record. The fire logs "dispatched an entry step" and then goes
        // quiet, so without this the only evidence an entry step ever finished was a hand-off line
        // naming a successor — and an entry step that is ALSO terminal produced no such line at all.
        // Both halves now name themselves, under the correlation id the fire minted.
        if (entry.Definition.EntryStepIds.Contains(m.StepId))
        {
            _logger.LogInformation("the entry step completed with {Result}", m.Result);
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

        // The duplicate-delivery branch. Returning HERE is what makes acking safe: it precedes every
        // hand-off and the reclaim, so a second attempt at an outcome advances nothing and deletes
        // nothing. The ids ride the open scope; the template carries none of them.
        if (data is null)
        {
            _logger.LogWarning(
                "the execution blob is absent — treating as a duplicate delivery, advancing nothing");
            return;
        }

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
                "the terminal step completed with {Result} — no successor accepts it, the run ends here",
                m.Result);
        }
        else
        {
            _logger.LogInformation(
                "advanced {SuccessorCount} successor(s) in {ElapsedMs}ms",
                selection.Matches.Count, (int)Stopwatch.GetElapsedTime(started).TotalMilliseconds);
        }

        // Unconditional, and last. See the type remarks: every path reaching here has acked the
        // outcome as final, and a store fault must propagate so the classifier trips the gate and
        // requeues rather than acknowledging a hand-off whose source was never reclaimed.
        await ReclaimAsync(m.EntryId).ConfigureAwait(false);
    }

    /// <summary>
    /// Deletes the execution blob this outcome names, if it names one.
    /// <para>
    /// <b>Called on every disposition that ends this replica's responsibility for the message —
    /// acked and parked alike.</b> Only a requeue-nack skips it, because that delivery is coming
    /// back and will need the blob to still be there.
    /// </para>
    /// <para>
    /// A store fault propagates rather than being swallowed, on both callers. On the acked path that
    /// is what stops a hand-off being acknowledged with its source unreclaimed. On the parked path it
    /// converts the park into a requeue — which is the better answer anyway: the store being
    /// unreachable says nothing about the message, and a redelivery may well find L1 caught up.
    /// </para>
    /// </summary>
    private async Task ReclaimAsync(Guid entryId)
    {
        // Guid.Empty is not a key: a failed source step, an output that failed its schema and a
        // cancelled source step all report it, and it means there is no blob to reclaim.
        if (entryId == Guid.Empty)
        {
            return;
        }

        _logger.LogDebug("reclaiming the source blob from L2");

        await _redis.GetDatabase()
            .KeyDeleteAsync(L2ProjectionKeys.ExecutionData(entryId))
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Reads the finished step's blob. Returns <c>null</c> when the key is absent, which the caller
    /// treats as a duplicate delivery.
    /// <para>
    /// <b>An absent key is acked, matching the processor's pre handler.</b> This used to park, on the
    /// grounds that the key could equally have been removed by a previous attempt at this outcome or
    /// never written at all, the second being a real defect. <b>The second reading is not
    /// reachable.</b> By the time this runs: the workflow and step are in L1 (a miss already threw
    /// <see cref="DescribeL1Miss"/> above); <c>EntryId</c> is not the empty sentinel (that path never
    /// reads); the write happened, because <c>ProcessedDataHandler</c> writes before it sends and
    /// sends <c>Guid.Empty</c> when it did not write — its own comment says naming the key would
    /// "send the orchestrator to reclaim a key that was never written"; and nothing else deletes this
    /// key. The processor's reclaim takes its own INPUT, a different guid, since a fresh key is
    /// minted per successor below. So an absent key means this outcome was already handled.
    /// </para>
    /// <para>
    /// <b>And the park did not preserve what it was for.</b> A parked outcome cannot be replayed —
    /// the replay re-reads the same absent key and parks again — so it was a message that could only
    /// be read once and deleted, at the cost of an entry in <c>pipeline.deadletter.depth</c> and an
    /// interruption. The rate tracked restarts and migrations rather than defects: one planned
    /// scale-down on 2026-08-31 produced a park 32ms after the replica admitted consumption, for a
    /// run that had already completed four times over.
    /// </para>
    /// <para>
    /// Logged at Warning rather than the processor's Information, because the processor can PROVE its
    /// own reclaim removed the key and this infers it from the argument above. A burst here means
    /// outcomes are being redelivered in volume, which is worth seeing.
    /// </para>
    /// <para>
    /// See <c>docs/superpowers/specs/2026-09-01-absent-key-disposition-design.md</c>. The forgery
    /// case this branch used to catch incidentally — a real workflow and step with a bogus EntryId —
    /// belongs to a provenance guard on this queue, the sibling of the one
    /// <c>ProcessedDataHandler</c> carries; it is not this branch's job and never did it well.
    /// </para>
    /// </summary>
    private async Task<byte[]?> ReadAsync(Guid entryId)
    {
        _logger.LogDebug("reading the finished step's blob from L2");

        // A store fault propagates: the consumer classifies it, closes the gate and returns the
        // delivery. Catching it here would acknowledge an outcome that was never acted on.
        var raw = await _redis.GetDatabase()
            .StringGetAsync(L2ProjectionKeys.ExecutionData(entryId))
            .ConfigureAwait(false);

        if (raw.IsNullOrEmpty)
        {
            // Null, not an exception: the caller returns without advancing or reclaiming, and the
            // consumer acks. Matches ProcessDispatchHandler's "entry absent" branch, which is the
            // divergence this closes.
            return null;
        }

        return (byte[])raw!;
    }
}
