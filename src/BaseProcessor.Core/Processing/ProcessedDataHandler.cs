using System.Diagnostics;
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
/// Finishes one branch: validate the output, persist it, report the outcome.
/// <para>
/// <b>It is not the only place an outcome comes from, and it stopped being so on 2026-09-11.</b> An
/// author that ends the lineage produces no branch, so this handler never runs for it and its
/// terminal outcome is reported by <c>ProcessDispatchHandler</c> instead — see
/// <see cref="BaseProcessor.EndsLineage"/>. The summary above is scoped to a branch, and a sink has
/// none; read it as "every branch's outcome" rather than "every outcome".
/// </para>
/// <para>
/// <b>Every branch is keyed by an entry id that rides the message body</b>, so a redelivery of THIS
/// message repeats the sequence exactly — the write rewrites the same key with the same bytes, the
/// outcome send repeats. That idempotence is what lets this handler use a plain NACK as its whole
/// recovery mechanism. Note the scope of the claim: it holds for a redelivery of the branch, because
/// the id is already minted and rides the body. A redelivery of the DISPATCH re-runs the author and
/// mints a fresh one — see <see cref="BaseProcessor.SendToPostAsync"/>.
/// </para>
/// <para>
/// <b>The output is written to <c>data:{entryId}</c>, and the successor does NOT read that key.</b>
/// <c>StepOutcomeHandler</c> reads this blob, mints a fresh key per matched successor — Guid.NewGuid,
/// unconditionally, with no single-successor shortcut — writes the data there through
/// <c>NextStepHandoffHandler</c>, and reclaims this one last. A hop RELOCATES the payload rather than
/// passing a reference, so this key is dead by the time any successor runs.
/// </para>
/// <para>
/// <b>Fan-out is therefore the orchestrator's problem, and it is solved there rather than here.</b>
/// This paragraph used to describe the hazard as open: three successors dispatched against ONE key,
/// the first one's pre hop reclaiming it, the other two finding it absent and losing their branches
/// silently. The per-successor mint above is what closed it. Nothing in this assembly defends against
/// it — still by decision rather than oversight, and now because there is nothing left to defend
/// against.
/// </para>
/// <para>
/// Both paragraphs claimed the opposite until 2026-09-11, and were accurate when written in 93edbcd,
/// where a step's output WAS the key its successor read. 96939c1 introduced the orchestrator's graph
/// advancement two days later and left them behind, along with the call-site comment beside the
/// outcome send.
/// </para>
/// </summary>
internal sealed class ProcessedDataHandler : IQueueMessageHandler
{
    private readonly IConnectionMultiplexer _redis;
    private readonly IQueueSender _sender;
    private readonly IProcessorContext _context;
    private readonly ILogger<ProcessedDataHandler> _logger;

    public ProcessedDataHandler(
        IConnectionMultiplexer redis,
        IQueueSender sender,
        IProcessorContext context,
        ILogger<ProcessedDataHandler> logger)
    {
        _redis   = redis ?? throw new ArgumentNullException(nameof(redis));
        _sender  = sender ?? throw new ArgumentNullException(nameof(sender));
        _context = context ?? throw new ArgumentNullException(nameof(context));
        _logger  = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public string MessageType => MessageTypes.ProcessedData;

    public async Task HandleAsync(ReadOnlyMemory<byte> body, CancellationToken ct)
    {
        var p = JsonSerializer.Deserialize<ProcessedData>(body.Span, MessagingJson.Options)
                ?? throw new JsonException("processed-data deserialized to null");

        using (_logger.BeginScope(ExecutionLogScope.BuildScope(p)))
        using (_logger.BeginScope(new Dictionary<string, object>
               {
                   [CorrelationKeys.LogScope] = CorrelationKeys.Render(p.CorrelationId),
               }))
        {
            await RunAsync(p, ct).ConfigureAwait(false);
        }
    }

    private async Task RunAsync(ProcessedData p, CancellationToken ct)
    {
        _logger.LogDebug("validating and persisting a branch");
        var started = Stopwatch.GetTimestamp();

        // Identity is needed for the output schema below AND for the provenance guard that follows,
        // and nothing gates consumption on IProcessorContext.IsHealthy today, so this can genuinely
        // run while the startup loops are still resolving. See the known gap in the execution-path
        // plan; every guard here parks rather than proceeds until it is closed.
        var identity = _context.Identity
            ?? throw new InvalidOperationException(
                "A branch was consumed before identity resolved — the queue must not be bound until then.");

        // PROVENANCE. This used to read "a routing and tracing id rather than a claim to verify", on
        // the grounds that the value was stamped by this processor one hop ago and the branch came
        // back on this processor's own queue. Both halves are still true and neither is ENFORCED:
        // processor-{id}-post is an addressable queue on a shared broker, this handler is resolved by
        // message type across the whole container, and everything below acts on the ids in the body
        // — it writes L2[EntryId] from them and reports a StepOutcome under them. A message arriving
        // with someone else's ProcessorId would write a blob into another lineage's key space and
        // forge that step's outcome. The reference carried this guard as WR-02 for exactly that
        // reason; this assembly lost it in the port.
        //
        // PARKED, not dropped, which is where this departs from the reference. Dropping leaves a log
        // line and nothing else, and the two ways this can fire want opposite handling: a bug on our
        // own send path is a branch that must not vanish silently, while a forged message is
        // evidence. Parking preserves both. It cannot flood the dead-letter queue in this deployment
        // — the broker is in-cluster with no external reach — and if that ever changes, dropping
        // becomes the right trade and this comment is where to make it.
        //
        // Ids only, never the payload, matching the schema-failure branch below.
        if (p.ProcessorId != identity.Id)
        {
            throw new InvalidOperationException(
                $"branch carries ProcessorId {p.ProcessorId:D} but this processor is {identity.Id:D} — "
                + "refusing to write a blob or report an outcome for another processor's lineage");
        }

        // The same "not applicable" vs "not yet" pair the pre handler reads, on the output role. A
        // non-null schema id whose definition is still null would hand TryValidate a null definition,
        // which returns true by contract — so the branch would be persisted and reported complete with
        // the output schema silently not applied. Parking keeps it recoverable from the DLQ.
        if (identity.OutputSchemaId is { } outputSchemaId && identity.OutputDefinition is null)
        {
            throw new InvalidOperationException(
                $"Output schema {outputSchemaId:D} has not resolved yet, so the output cannot be "
                + "validated — the work queue must not be bound before the processor reaches Healthy.");
        }

        if (!ProcessorJsonSchemaValidator.TryValidate(identity.OutputDefinition, p.Data, out var errors))
        {
            // The errors are logged and go nowhere else — StepOutcome has no text field, and validator
            // output routinely quotes the fragment of the document that failed, which is exactly what
            // must not reach the orchestrator's projections.
            // Warning, matching the input-schema line in the pre handler: both are a step failing,
            // and severity is what an operator filters on before they know which half broke.
            // THE SCHEMA ID IS ON THE LINE, and it is not decoration. A schema edge is a row id on
            // the PROCESSOR row, shared by every workflow that uses this processor, and re-pointing
            // it is a routine act -- so "which schema refused this" has a different answer at
            // different times, and the errors alone cannot distinguish a document that is wrong from
            // an edge that was moved. Found while running the schema-compatibility suite on
            // 2026-09-12, where attributing a rejection meant correlating timestamps against a
            // separate record of what the edge pointed at that minute.
            //
            // The id and not the name: ProcessorIdentity carries ids and definitions, and the name
            // would have to be threaded through the identity RPC to reach here.
            _logger.LogWarning(
                "output failed its schema {OutputSchemaId} — reported failed: {SchemaErrors}",
                identity.OutputSchemaId, string.Join("; ", errors));

            // Guid.Empty, not p.EntryId: the write below never ran, so that key does not exist, and
            // naming it would send the orchestrator to reclaim a key that was never written. The step's
            // own input is already gone — the pre handler reclaimed it when the author returned
            // normally, which is how this branch came to exist at all — so there is genuinely no key
            // for the orchestrator to deal with here.
            await SendAsync(
                new StepOutcome(p.CorrelationId, p.ExecutionId, p.WorkflowId, p.StepId, p.ProcessorId,
                                Guid.Empty, StepResult.Failed), ct).ConfigureAwait(false);
            return;
        }

        var db = _redis.GetDatabase();

        // When/flags passed explicitly: StackExchange.Redis overloads a bare (key, value, expiry) call
        // between a keepTtl-bool overload and an Expiration-struct overload, and the compiler resolves
        // it to the former — silently a different method than the (expiry, When, CommandFlags) one
        // most call sites (and tests) expect. Naming all five parameters pins the overload.
        //
        // The expiry is null on purpose. This blob is the successor's input, and an expiry would
        // delete a live workflow's input mid-hand-off.
        _logger.LogDebug("writing the branch output to L2");

        await db.StringSetAsync(
                L2ProjectionKeys.ExecutionData(p.EntryId),
                p.Data,
                null,
                When.Always,
                CommandFlags.None)
            .ConfigureAwait(false);

        // EntryId names the key just written, and the orchestrator does NOT hand it on.
        // StepOutcomeHandler reads this blob, mints a fresh key per matched successor (Guid.NewGuid,
        // unconditionally — there is no single-successor shortcut), writes the data there via
        // NextStepHandoffHandler, and reclaims this one last. So a hop RELOCATES the payload rather
        // than passing a reference: this key is dead by the time any successor runs, which is why
        // skp:data:* is empty between dispatches and why observing an intermediate branch means
        // holding its consumer down.
        //
        // It is still reported here because the outcome must name the blob the orchestrator has to
        // read and then reclaim — this id is a handle for the hop that follows, not the successor's
        // input key.
        //
        // This comment claimed the opposite until 2026-09-11. It was accurate when written in
        // 93edbcd, where a step's output WAS the key its successor read; 96939c1 introduced the
        // orchestrator's graph advancement two days later, which had to mint a key per successor to
        // support fan-out, and left this behind.
        await SendAsync(
            new StepOutcome(p.CorrelationId, p.ExecutionId, p.WorkflowId, p.StepId, p.ProcessorId,
                            p.EntryId, StepResult.Completed), ct).ConfigureAwait(false);

        // Every id rides the open scope, so the template carries none of them — and never the data,
        // since this line is about the delivery rather than its content.
        _logger.LogInformation(
            "branch completed in {ElapsedMs}ms", (int)Stopwatch.GetElapsedTime(started).TotalMilliseconds);
    }

    private Task SendAsync(StepOutcome outcome, CancellationToken ct)
        => _sender.SendTransientAsync(OrchestratorQueues.Result, MessageTypes.StepOutcome, outcome, ct);
}
