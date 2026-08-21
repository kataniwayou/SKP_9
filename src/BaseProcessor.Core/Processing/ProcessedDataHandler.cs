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
/// <b>Every branch is keyed by an entry id that rides the message body</b>, so a redelivery of THIS
/// message repeats the sequence exactly — the write rewrites the same key with the same bytes, the
/// outcome send repeats. That idempotence is what lets this handler use a plain NACK as its whole
/// recovery mechanism. Note the scope of the claim: it holds for a redelivery of the branch, because
/// the id is already minted and rides the body. A redelivery of the DISPATCH re-runs the author and
/// mints a fresh one — see <see cref="BaseProcessor.SendToPostAsync"/>.
/// </para>
/// <para>
/// <b>The output is written to <c>data:{entryId}</c>, which is the successor's input key
/// unchanged.</b> One blob, one namespace, no relocation — the orchestrator hands the id straight
/// through when a step has exactly one successor.
/// </para>
/// <para>
/// <b>That makes multi-successor fan-out the orchestrator's problem, not this handler's.</b> Three
/// successors dispatched against one key means the first one's PRE hop reclaims it and the other two
/// find it absent and return with no result — two branches lost silently. The orchestrator must copy
/// the blob into one key per successor under derived ids, or refcount it. Nothing in this assembly
/// defends against it, by decision rather than by oversight.
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
        // Same as the pre handler: ProcessorId is passed through with WorkflowId and StepId, a
        // routing and tracing id rather than a claim to verify. The value arriving here was stamped by
        // this processor one hop ago off the dispatch that named it, and the branch was sent to this
        // processor's own queue — so re-resolving it from identity would be a second read of the same
        // fact and would leave the field written and never read.
        //
        // Identity is still needed for the output schema below, and nothing gates consumption on
        // IProcessorContext.IsHealthy today, so this can genuinely run while the startup loops are
        // still resolving. See the known gap in the execution-path plan; both guards here park rather
        // than proceed until it is closed.
        var identity = _context.Identity
            ?? throw new InvalidOperationException(
                "A branch was consumed before identity resolved — the queue must not be bound until then.");

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
            _logger.LogInformation(
                "output failed its schema — reported failed: {SchemaErrors}", string.Join("; ", errors));

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
        await db.StringSetAsync(
                L2ProjectionKeys.ExecutionData(p.EntryId),
                p.Data,
                null,
                When.Always,
                CommandFlags.None)
            .ConfigureAwait(false);

        // EntryId travels straight through: the key just written IS the key the successor reads as
        // its input. One blob, one namespace, no relocation — for a single successor the orchestrator
        // hands this id on unchanged.
        await SendAsync(
            new StepOutcome(p.CorrelationId, p.ExecutionId, p.WorkflowId, p.StepId, p.ProcessorId,
                            p.EntryId, StepResult.Completed), ct).ConfigureAwait(false);

        // Every id rides the open scope, so the template carries none of them — and never the data,
        // since this line is about the delivery rather than its content.
        _logger.LogInformation("branch completed");
    }

    private Task SendAsync(StepOutcome outcome, CancellationToken ct)
        => _sender.SendTransientAsync(OrchestratorQueues.Result, MessageTypes.StepOutcome, outcome, ct);
}
