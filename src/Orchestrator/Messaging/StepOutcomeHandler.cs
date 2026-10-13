using System.Diagnostics;
using System.Runtime.ExceptionServices;
using System.Text.Json;
using BaseConsole.Core.Gating;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
using Orchestrator.Dispatch;
using Orchestrator.L1;
using StackExchange.Redis;

namespace Orchestrator.Messaging;

/// <summary>
/// The pre hop: takes one step's outcome, decides which successors it lets through, and dispatches each
/// of them with a copy of the finished step's blob.
/// <para>
/// <b>Check once, hand off N times in-process, reclaim last.</b> Each matched successor gets a key of
/// its own, derived (<see cref="EntryIds.Successor"/>) so a redelivery names the same one: a Completed
/// step's blob is copied there inside Redis (COPY without REPLACE), anything else gets <c>""</c> (no
/// data). The dispatch is sent from here — no hand-off message carries the blob any more, because the
/// organisation caps RabbitMQ's message size — and each dispatched successor is remembered in
/// <c>handoff:{E}</c>, so a redelivered outcome sends only what an earlier attempt did not. See
/// <c>docs/superpowers/specs/2026-10-12-in-process-post-derived-keys-design.md</c> §8.
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
            await ReclaimAsync(
                    m.EntryId,
                    L2ProjectionKeys.ExecutionHandoffs(EntryIds.HandoffSource(m.EntryId, m.CorrelationId, m.StepId)))
                .ConfigureAwait(false);

            // Described only here, on the cold path. The condition above stays a short-circuited pair
            // of dictionary hits because it is the hot path -- every outcome from every processor
            // runs it -- and re-reading the store to build a sentence is affordable exactly once, in
            // the branch that is about to throw the message away.
            throw new InvalidOperationException(DescribeL1Miss(_store, m.WorkflowId, m.StepId));
        }

        // PROVENANCE. The sibling of the guard ProcessedDataHandler carries on the branch hop, and
        // it exists for the same reason: orchestrator-result is an addressable queue on a shared
        // broker, this handler is resolved by message type across the whole container, and
        // everything below acts on the ids in the body — it checks the key under EntryId exists,
        // copies it to the successors' keys, dispatches them, and reclaims. Until now nothing compared the message against anything but
        // the existence of its workflow and step, so an outcome naming a real workflow and a real
        // step could be minted by anyone and would advance that workflow.
        //
        // L1 is the authority the processor's own identity is on the other side: StepL1.ProcessorId
        // is "the processor that executes this step", and every legitimate outcome carries it. All
        // three senders are covered — ProcessedDataHandler's two sends carry p.ProcessorId, which
        // WR-02 has already proven equal to that processor's own identity, and the dispatch that
        // named it was addressed to processor-{L1.ProcessorId}; this handler's own failure outcome
        // (below) carries the id read from this same field, and NextStepHandoffHandler's, while it
        // drains release-1 hand-offs, the id this orchestrator put in the hand-off.
        //
        // NOT RECLAIMED BEFORE PARKING, and that is the one place this deliberately departs from the
        // L1-miss branch above. That branch reclaims to avoid leaking a blob. Here the message has
        // just FAILED an authenticity check, so its EntryId is unauthenticated input — and a forged
        // outcome can name a blob belonging to a real execution still in flight. Reclaiming would
        // make the forgery destructive by our own hand, turning a message we refused into a deleted
        // input for a run that was doing nothing wrong. A leaked blob is the cheaper failure, and
        // this branch should be rare enough that it is not a leak worth trading for that.
        //
        // The one legitimate way to reach this: a step reassigned to a different processor while an
        // outcome from the previous definition is still in flight. That is the same class of event as
        // a step REMOVED mid-run, which the branch above already parks — "it holds a definition that
        // disagrees with the outcome in flight" — so parking it here is consistent rather than new.
        //
        // Ids only, never the payload, matching the guard on the other side.
        if (m.ProcessorId != completed.ProcessorId)
        {
            throw new InvalidOperationException(
                $"the outcome for step {m.StepId:D} claims processor {m.ProcessorId:D} but this "
                + $"workflow's definition assigns that step to {completed.ProcessorId:D} — refusing "
                + "to advance the graph on an outcome whose provenance does not check out");
        }

        // CHECK BEFORE NARRATING: a delivery that advances nothing must not announce "the entry step
        // completed" first (RunLedger's I8 counts that line exactly).
        //
        // EXISTS, never a read: the blob is copied inside Redis and never loaded here. Absent means an
        // earlier delivery of this outcome advanced and reclaimed it — the absent-key disposition
        // (docs/superpowers/specs/2026-09-01-absent-key-disposition-design.md). Guid.Empty names no
        // key at all — an entry step's Failed or Cancelled outcome — and skips the check.
        //
        // The delete stays LAST, after every hand-off: a hand-off that fails is redelivered and must
        // still find the key, or the successors would never be dispatched.
        if (m.EntryId != Guid.Empty && !await ExistsAsync(m.EntryId).ConfigureAwait(false))
        {
            _logger.LogWarning(
                "the execution blob is absent — treating as a duplicate delivery, advancing nothing");
            return;
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

        // THE SEVERITY OF A RUN'S OWN RECORD, and it is a variable because both lines that carry
        // {Result} report a failure whenever the step failed — this is the orchestrator's half of the
        // event the processor already logs at Warning, and a severity sweep that finds one and not the
        // other is worse than one that finds neither. Raised on 2026-09-11, applying the reasoning of
        // 614e688 ("make failures findable") to this side.
        //
        // Failed, NOT `!= Completed`. Cancelled is an author ending its own branch deliberately, and
        // the processor keeps its cancellation line at Information for exactly that reason; promoting
        // it here would make the two sides disagree again, in the other direction.
        //
        // The templates below are untouched. body.text is indexed as a keyword, so every saved query
        // matching them keeps working and this change is additive: what was findable by text stays
        // findable by text, and is now findable by level as well.
        var level = m.Result == StepResult.Failed ? LogLevel.Warning : LogLevel.Information;

        // The opening half of a run's record. The fire logs "dispatched an entry step" and then goes
        // quiet, so without this the only evidence an entry step ever finished was a hand-off line
        // naming a successor — and an entry step that is ALSO terminal produced no such line at all.
        // Both halves now name themselves, under the correlation id the fire minted.
        if (entry.Definition.EntryStepIds.Contains(m.StepId))
        {
            _logger.Log(level, "the entry step completed with {Result}", m.Result);
        }

        var selection = StepAdvancement.SelectNext(m.Result, completed, entry.Steps);

        var db = _redis.GetDatabase();
        var source = EntryIds.HandoffSource(m.EntryId, m.CorrelationId, m.StepId);
        var handoffs = L2ProjectionKeys.ExecutionHandoffs(source);

        // A failure report that could not itself be sent. Rethrown AFTER the loop, so one broken
        // successor no longer stops its siblings; the keys it named are reclaimed first.
        ExceptionDispatchInfo? park = null;
        var unreported = new List<Guid>();

        foreach (var next in selection.Matches)
        {
            var successorId = EntryIds.Successor(m.EntryId, m.CorrelationId, m.StepId, next.StepId);
            var dispatchStarted = Stopwatch.GetTimestamp();

            // CHECKED BEFORE MATERIALIZING, and the order matters. A successor in the set was already
            // dispatched by an earlier attempt, so it owns its key and may since have run, finished
            // and reclaimed it; materializing again would recreate a key nobody will ever read or
            // delete (no TTL, no sweeper). An unroutable send is transient and requeues the WHOLE
            // outcome, so without this set every sibling before the failing one would also be
            // dispatched again on every retry. A crash between the dispatch and the SADD still
            // re-materializes and re-dispatches: the accepted rare case (spec limit 1).
            if (await db.SetContainsAsync(handoffs, next.StepId.ToString("D")).ConfigureAwait(false))
            {
                continue;
            }

            var materialized = false;

            try
            {
                await MaterializeAsync(db, m, successorId).ConfigureAwait(false);
                materialized = true;

                // A dispatch STARTS a step, so the clock starts here rather than being inherited from
                // the outcome being handled.
                MessageClock.BeginChain();

                await _sender
                    .SendTransientAsync(
                        ProcessorQueues.Work(next.ProcessorId), MessageTypes.ProcessDispatch,
                        new ProcessDispatch(
                            m.CorrelationId, m.ExecutionId, m.WorkflowId, next.StepId, next.ProcessorId,
                            next.Payload, successorId),
                        ct)
                    .ConfigureAwait(false);

                // After the confirm, never before: a crash between the two dispatches this successor
                // again — a duplicate, which this system prefers to a loss.
                await db.SetAddAsync(handoffs, next.StepId.ToString("D")).ConfigureAwait(false);

                _logger.LogInformation(
                    "handed off to {NextStepId} on {NextProcessorId} with {NextEntryId}",
                    next.StepId, next.ProcessorId, successorId);
                _logger.LogInformation(
                    "dispatched in {ElapsedMs}ms", (int)Stopwatch.GetElapsedTime(dispatchStarted).TotalMilliseconds);
            }
            catch (Exception ex) when (!IsRecoverable(ex))
            {
                // Deterministic: redelivery cannot help. Report THIS successor failed under its own key
                // — so that outcome reclaims it and the graph's failure branch runs — and carry on with
                // its siblings. The message is logged, never sent.
                _logger.LogError(ex, "could not start the step — reporting it failed");

                var reportedId = successorId;

                try
                {
                    // AN OUTCOME MUST NAME A KEY THAT EXISTS, OR NONE. If the materialization itself
                    // failed (NOPERM on COPY, an old Redis without COPY, CROSSSLOT), data:{S} was never
                    // written, and a Failed outcome naming it would meet "EXISTS data:{S}" = false on
                    // delivery and be dropped as a duplicate — the successor's failure branch would
                    // never run. So write the empty key first, best effort. If even that write is
                    // deterministically refused, name Guid.Empty (no key at all, which skips the check);
                    // a recoverable fault from it propagates and requeues like any other.
                    if (!materialized)
                    {
                        try
                        {
                            await db.StringSetAsync(
                                    L2ProjectionKeys.ExecutionData(successorId), RedisValue.EmptyString, null,
                                    When.NotExists, CommandFlags.None)
                                .ConfigureAwait(false);
                        }
                        catch (Exception write) when (!IsRecoverable(write))
                        {
                            _logger.LogError(write, "could not write the step's empty input either — reporting no key");
                            reportedId = Guid.Empty;
                        }
                    }

                    await _sender.SendTransientAsync(
                            OrchestratorQueues.Result,
                            MessageTypes.StepOutcome,
                            new StepOutcome(
                                m.CorrelationId, m.ExecutionId, m.WorkflowId, next.StepId, next.ProcessorId,
                                reportedId, StepResult.Failed),
                            ct)
                        .ConfigureAwait(false);

                    await db.SetAddAsync(handoffs, next.StepId.ToString("D")).ConfigureAwait(false);
                }
                catch (Exception report) when (!IsRecoverable(report))
                {
                    // Nothing will ever name this key: reclaim it and park, after the siblings.
                    _logger.LogError(
                        report, "could not report the failed step either — reclaiming its input and parking");
                    if (reportedId != Guid.Empty)
                    {
                        unreported.Add(reportedId);
                    }

                    park ??= ExceptionDispatchInfo.Capture(report);
                }
            }
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
            // StepRole=terminal marks the run's exit edge, two ways: a Completed outcome that no
            // successor accepts (split-exporter, whose only successor takes Failed), or any outcome of
            // a step with no successors in THIS workflow's graph. A Failed or Cancelled outcome of a
            // step that has successors ends its branch too, but it is not an edge and carries nothing.
            // Inside this block no successor matched, so "Completed" alone is the first half. The
            // graph is the L1 entry this outcome was just routed from, so a step shared by two
            // workflows is classified per workflow. See StepRoles.
            var terminal = m.Result == StepResult.Completed || completed.NextStepIds is not { Count: > 0 };
            using (terminal ? _logger.BeginScope(StepRoles.Scope(StepRoles.Terminal)) : null)
            {
                _logger.Log(level, OutcomeTemplates.BranchEnds, m.Result);
            }
        }
        else
        {
            // A FAILED STEP THAT ADVANCES ANYWAY WAS REPORTED NOWHERE ON THIS SIDE, which is the same
            // shape as the sink whose success nobody reported: the line below says only how many
            // successors ran and how long it took, so a mid-run failure left no orchestrator record at
            // all unless the step happened to be an entry or terminal one. Both {Result} lines above
            // are conditional on position; this hole sat between them.
            //
            // It is also where the entry-condition Always footgun becomes visible. Always accepts a
            // failed predecessor by design, so a workflow wired that way dispatches the rest of itself
            // on a step that did not produce anything — which is a decision the author made and worth
            // seeing, not an error to swallow. Warning, before the advancement line rather than
            // instead of it: the count and the elapsed time are still the record of what happened.
            if (m.Result != StepResult.Completed)
            {
                _logger.LogWarning(
                    "advancing {SuccessorCount} successor(s) on a {Result} step — their entry "
                    + "conditions accept it",
                    selection.Matches.Count, m.Result);
            }

            _logger.LogInformation(
                OutcomeTemplates.Advanced,
                selection.Matches.Count, (int)Stopwatch.GetElapsedTime(started).TotalMilliseconds);
        }

        // Unconditional, and last — after every hand-off. See the type remarks: every path reaching
        // here has acked the outcome as final, and a store fault must propagate so the classifier trips
        // the gate and requeues rather than acknowledging a hand-off whose source was never reclaimed.
        foreach (var orphan in unreported)
        {
            await db.KeyDeleteAsync(L2ProjectionKeys.ExecutionData(orphan)).ConfigureAwait(false);
        }

        await ReclaimAsync(m.EntryId, handoffs).ConfigureAwait(false);

        park?.Throw();
    }

    /// <summary>
    /// Deletes the outcome's blob and its hand-off set, in one call.
    /// <para>
    /// <b>Called on every disposition that ends this replica's responsibility for the message —
    /// acked and parked alike.</b> Only a requeue-nack skips it, because that delivery is coming back
    /// and will need both to still be there. A store fault propagates on both callers: on the acked
    /// path that stops a hand-off being acknowledged with its source unreclaimed, and on the parked
    /// path it converts the park into a requeue, which is the better answer anyway.
    /// </para>
    /// </summary>
    private async Task ReclaimAsync(Guid entryId, string handoffs)
    {
        _logger.LogDebug("reclaiming the source blob from L2");

        // Guid.Empty names no blob; the hand-off set may exist either way.
        var keys = new List<RedisKey> { handoffs };
        if (entryId != Guid.Empty)
        {
            keys.Add(L2ProjectionKeys.ExecutionData(entryId));
        }

        await _redis.GetDatabase().KeyDeleteAsync([.. keys]).ConfigureAwait(false);
    }

    /// <summary>
    /// Whether the outcome's key is still present. Absent means an earlier delivery of this outcome
    /// already advanced and reclaimed it.
    /// </summary>
    private async Task<bool> ExistsAsync(Guid entryId)
    {
        _logger.LogDebug("checking the finished step's key is still in L2");

        return await _redis.GetDatabase()
            .KeyExistsAsync(L2ProjectionKeys.ExecutionData(entryId))
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Gives one successor its input under <paramref name="successorId"/>.
    /// <para>
    /// <b>Only a Completed outcome's blob is data (spec D6)</b>: copied inside Redis, never loaded
    /// here. COPY without REPLACE: <c>false</c> means an earlier attempt made the key, or the source is
    /// already gone (a concurrent replica finished this outcome and reclaimed it); dispatching is still
    /// correct either way, because that replica dispatched every successor before its DEL. Anything else — Failed, Cancelled, or an outcome naming no key — gets
    /// <c>""</c>, written NX for the same reason.
    /// </para>
    /// </summary>
    private async Task MaterializeAsync(IDatabase db, StepOutcome m, Guid successorId)
    {
        var target = L2ProjectionKeys.ExecutionData(successorId);

        if (m.Result == StepResult.Completed && m.EntryId != Guid.Empty)
        {
            _logger.LogDebug("copying the finished step's blob to the successor's key");
            await db.KeyCopyAsync(L2ProjectionKeys.ExecutionData(m.EntryId), target).ConfigureAwait(false);
            return;
        }

        await db.StringSetAsync(target, RedisValue.EmptyString, null, When.NotExists, CommandFlags.None)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Whether redelivering the outcome could succeed where this attempt did not: a transport fault on
    /// a send, or the store being unreachable (or OOM, READONLY, LOADING, BUSY). Everything else is
    /// deterministic, and misclassifying in that direction reports one step failed rather than
    /// requeueing a message that fails identically forever.
    /// </summary>
    private static bool IsRecoverable(Exception ex) =>
        ex is TransientSendException || L2FaultClassifier.IsTransient(ex);
}
