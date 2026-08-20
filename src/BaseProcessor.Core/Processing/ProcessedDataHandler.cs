using System.Text.Json;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Validation;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

namespace BaseProcessor.Core.Processing;

/// <summary>
/// Finishes one branch: reclaim the input, validate the output, persist it, report the outcome.
/// <para>
/// <b>Every step is keyed by a message id that rides the message body</b>, so a redelivery repeats
/// the sequence exactly — the delete no-ops on an absent key, the write rewrites the same key with
/// the same bytes, the result send repeats. That idempotence is what lets this handler use a plain
/// NACK as its whole recovery mechanism.
/// </para>
/// <para>
/// <b>The delete goes first, and not merely because the input is finished with.</b> It is the most
/// failure-prone operation here, so it belongs before the ones whose repetition costs something:
/// delete last and a failed delete replays a write and a result send, so the orchestrator sees a
/// duplicate result; delete first and a failed delete replays only itself.
/// </para>
/// <para>
/// <b>The output goes to the <c>out:</c> namespace, never straight to <c>data:</c>.</b> A step with
/// three successors would otherwise produce three dispatches reading one key — the first successor's
/// post handler would reclaim it and the other two would find it absent, return without processing,
/// and vanish. The orchestrator relocates this blob into one input key per successor, so each
/// successor owns a key nobody else deletes.
/// </para>
/// </summary>
internal sealed class ProcessedDataHandler : IQueueMessageHandler
{
    private readonly IConnectionMultiplexer _redis;
    private readonly IQueueSender _sender;
    private readonly IProcessorContext _context;
    private readonly ProcessorLivenessOptions _options;
    private readonly ILogger<ProcessedDataHandler> _logger;

    public ProcessedDataHandler(
        IConnectionMultiplexer redis,
        IQueueSender sender,
        IProcessorContext context,
        IOptions<ProcessorLivenessOptions> options,
        ILogger<ProcessedDataHandler> logger)
    {
        _redis   = redis ?? throw new ArgumentNullException(nameof(redis));
        _sender  = sender ?? throw new ArgumentNullException(nameof(sender));
        _context = context ?? throw new ArgumentNullException(nameof(context));
        _options = options?.Value ?? throw new ArgumentNullException(nameof(options));
        _logger  = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public string MessageType => MessageTypes.ProcessedData;

    public async Task HandleAsync(ReadOnlyMemory<byte> body, CancellationToken ct)
    {
        var p = JsonSerializer.Deserialize<ProcessedData>(body.Span, MessagingJson.Options)
                ?? throw new JsonException("processed-data deserialized to null");

        using (_logger.BeginScope(ExecutionLogScope.BuildState(p)))
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
        // Same invariant as the pre handler: ProcessorId on every outbound message comes from OUR OWN
        // identity, never from the inbound one. Here the inbound ProcessedData was produced by this
        // processor, so its field is already ours by construction — which is exactly why echoing it
        // buys nothing and is the only way the two could ever disagree. Stamping from self keeps the
        // mismatch unrepresentable on both handlers, which is what lets this design carry no
        // provenance guard anywhere.
        var identity = _context.Identity
            ?? throw new InvalidOperationException(
                "A branch was consumed before identity resolved — the queue must not be bound until then.");
        var self = identity.Id;

        var db = _redis.GetDatabase();

        // A source step had no input key to begin with.
        if (p.EntryId != Guid.Empty)
        {
            await db.KeyDeleteAsync(L2ProjectionKeys.ExecutionData(p.EntryId)).ConfigureAwait(false);
        }

        if (!ProcessorJsonSchemaValidator.TryValidate(identity.OutputDefinition, p.Data, out var errors))
        {
            await SendAsync(new StepFailed(p.WorkflowId, p.StepId, self)
            {
                CorrelationId = p.CorrelationId,
                ExecutionId   = p.ExecutionId,
                ErrorMessage  = string.Join("; ", errors),
            }, MessageTypes.StepFailed, ct).ConfigureAwait(false);

            _logger.LogInformation("output failed its schema — reported failed {MessageId}", p.MessageId);
            return;
        }

        // When/flags passed explicitly: StackExchange.Redis overloads a bare (key, value, expiry) call
        // between a keepTtl-bool overload and an Expiration-struct overload, and the compiler resolves
        // it to the former — silently a different method than the (expiry, When, CommandFlags) one
        // most call sites (and tests) expect. Naming all five parameters pins the overload.
        await db.StringSetAsync(
                L2ProjectionKeys.OutputData(p.MessageId),
                p.Data,
                L2ProjectionKeys.OutputDataTtl(_options.ExecutionDataTtlSeconds),
                When.Always,
                CommandFlags.None)
            .ConfigureAwait(false);

        await SendAsync(new StepCompleted(p.WorkflowId, p.StepId, self)
        {
            CorrelationId = p.CorrelationId,
            ExecutionId   = p.ExecutionId,
            EntryId       = p.MessageId,   // the output key the orchestrator relocates
        }, MessageTypes.StepCompleted, ct).ConfigureAwait(false);

        // The message id is the one id the scope does not carry, so it goes in as a structured
        // argument. Never the data — this line is about the delivery, not its content.
        _logger.LogInformation("branch completed {MessageId}", p.MessageId);
    }

    private Task SendAsync<T>(T result, string type, CancellationToken ct)
        => _sender.SendTransientAsync(OrchestratorQueues.Result, type, result, ct);
}
