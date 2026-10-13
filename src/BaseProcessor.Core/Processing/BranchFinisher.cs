using System.Diagnostics;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Validation;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;

namespace BaseProcessor.Core.Processing;

/// <summary>
/// Finishes one branch, in-process: validate the output, write it under the branch's own key, report
/// the outcome.
/// <para>
/// <b>Why there is no queue.</b> The organisation caps RabbitMQ's message size, and a post queue
/// would have to carry the whole output inside every message. A queue's durability is what would let
/// the dispatch reclaim its input and ack right after the send; here the dispatch does not reclaim or
/// ack until this call returns, so the work's completion is the durable copy. See
/// <c>docs/superpowers/specs/2026-10-12-in-process-post-derived-keys-design.md</c>.
/// </para>
/// <para>
/// <b>Every branch has a real key.</b> <see cref="ProcessedData.EntryId"/> arrives derived
/// (<see cref="EntryIds.Branch"/>), so a replay of the dispatch rewrites the same key with the same
/// bytes. A branch with no data writes <c>""</c> there; a branch that fails its output schema writes
/// <c>""</c> and reports Failed under that same key, so every failed branch gets a successor key of
/// its own.
/// </para>
/// <para>
/// <b>Faults.</b> A send fault leaves as the <see cref="TransientSendException"/> the sender raised;
/// <see cref="BaseProcessor.SendToPostAsync"/> renames it. A store fault leaves raw, so
/// <c>L2FaultClassifier</c> sees it and the L2 gate closes. Neither is caught here.
/// </para>
/// </summary>
internal sealed class BranchFinisher : IBranchSink
{
    private readonly IConnectionMultiplexer _redis;
    private readonly IQueueSender _sender;
    private readonly IProcessorContext _context;
    private readonly ILogger<BranchFinisher> _logger;

    public BranchFinisher(
        IConnectionMultiplexer redis,
        IQueueSender sender,
        IProcessorContext context,
        ILogger<BranchFinisher> logger)
    {
        _redis   = redis ?? throw new ArgumentNullException(nameof(redis));
        _sender  = sender ?? throw new ArgumentNullException(nameof(sender));
        _context = context ?? throw new ArgumentNullException(nameof(context));
        _logger  = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async Task FinishAsync(ProcessedData branch, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(branch);

        // The branch's own ids, nested inside the dispatch's scope: its execution and entry ids are
        // not the dispatch's, and these lines are about the branch.
        using (_logger.BeginScope(ExecutionLogScope.BuildScope(branch)))
        {
            await RunAsync(branch, ct).ConfigureAwait(false);
        }
    }

    private async Task RunAsync(ProcessedData b, CancellationToken ct)
    {
        _logger.LogDebug("validating and persisting a branch");
        var started = Stopwatch.GetTimestamp();

        // Resolved before the author ran — ProcessDispatchHandler refuses a dispatch otherwise — so
        // reaching this with no identity is a wiring fault, not a race.
        var identity = _context.Identity
            ?? throw new InvalidOperationException(
                "A branch was sent before identity resolved — the dispatch that sent it must not have run.");

        if (b.Data.Length > 0)
        {
            // "Not applicable" vs "not yet", as on the input side. A non-null id whose definition is
            // still null would validate against nothing and pass by contract.
            if (identity.OutputSchemaId is { } outputSchemaId && identity.OutputDefinition is null)
            {
                throw new OutputSchemaPendingException(outputSchemaId);
            }

            if (!ProcessorJsonSchemaValidator.TryValidate(identity.OutputDefinition, b.Data, out var errors))
            {
                // The template is unchanged from the queue hop — Kibana and the live tests match it —
                // and the schema id stays on the line: the edge is a shared row that gets re-pointed,
                // so the errors alone cannot say whether the document or the contract moved.
                using (_logger.BeginScope(OutcomeLogScope.BuildScope(StepResult.Failed)))
                {
                    _logger.LogWarning(
                        "output failed its schema {OutputSchemaId} — reported failed: {SchemaErrors}",
                        identity.OutputSchemaId, string.Join("; ", errors));
                }

                // "" under the branch's own key, then Failed naming it. The rejected bytes are never
                // written: a failed step's output is not data (spec D6).
                await WriteAsync(b.EntryId, RedisValue.EmptyString).ConfigureAwait(false);
                await SendAsync(Outcome(b, StepResult.Failed), ct).ConfigureAwait(false);
                return;
            }
        }

        // Write, then report: the outcome names this key and the orchestrator reads it.
        await WriteAsync(b.EntryId, b.Data.Length == 0 ? RedisValue.EmptyString : (RedisValue)b.Data)
            .ConfigureAwait(false);
        await SendAsync(Outcome(b, StepResult.Completed), ct).ConfigureAwait(false);

        using (_logger.BeginScope(OutcomeLogScope.BuildScope(StepResult.Completed)))
        {
            _logger.LogInformation(
                "branch completed in {ElapsedMs}ms", (int)Stopwatch.GetElapsedTime(started).TotalMilliseconds);
        }
    }

    /// <summary>
    /// All five arguments, to pin the (key, value, expiry, When, flags) overload over the keepTtl one.
    /// No expiry: this blob is the successor's input, and an expiry would delete it mid-run.
    /// </summary>
    private Task<bool> WriteAsync(Guid entryId, RedisValue value)
    {
        _logger.LogDebug("writing the branch output to L2");

        return _redis.GetDatabase().StringSetAsync(
            L2ProjectionKeys.ExecutionData(entryId), value, null, When.Always, CommandFlags.None);
    }

    private static StepOutcome Outcome(ProcessedData b, StepResult result) =>
        new(b.CorrelationId, b.ExecutionId, b.WorkflowId, b.StepId, b.ProcessorId, b.EntryId, result);

    private Task SendAsync(StepOutcome outcome, CancellationToken ct)
        => _sender.SendTransientAsync(OrchestratorQueues.Result, MessageTypes.StepOutcome, outcome, ct);
}
