using BaseConsole.Core.Loop;
using BaseConsole.Core.Messaging;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Liveness;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace BaseProcessor.Core.Startup;

/// <summary>
/// The processor's startup brain: it discovers who this process is, then what its schemas say, and
/// only then declares itself healthy.
/// <list type="number">
///   <item><b>Loop A</b> — resolve the identity by source hash, retrying forever.</item>
///   <item><b>Loop B</b> — resolve the definition behind each non-null schema id, retrying forever.</item>
/// </list>
/// <para>
/// <b>Both loops retry without limit, and that is the requirement rather than a fallback.</b> A
/// processor image can be deployed before its database row exists, so "not found" is a normal early
/// answer, not an error — a bounded retry would turn an ordering the operator is allowed to choose
/// into a crash loop. Only shutdown ends either loop.
/// </para>
/// <para>
/// <b>The replica is published to L2 as unhealthy from the moment identity resolves</b>, and
/// rewritten on every Loop B iteration as per-schema progress advances. That is what makes a
/// still-starting replica visible as <c>unhealthy</c> rather than <c>absent</c>: both block the
/// orchestration gate, but only one of them says why. Nothing is written before identity, because
/// there is no processor id to key on.
/// </para>
/// <para>
/// <b>The recorded interval on those writes is the startup anchor, not the heartbeat cadence.</b>
/// These writes ride the retry backoff, so at the cap the gap between two of them reaches
/// <c>BackoffCap + RequestTimeout</c>; recording the 10s steady-state interval would derive a TTL
/// shorter than that gap and let a replica expire its own key between its own writes.
/// </para>
/// <para>
/// <b>When the dispatch endpoint is added, it must be bound before <c>MarkHealthy</c>.</b> The
/// heartbeat publishes <c>Healthy</c> to L2 only once that latch flips, and the orchestrator admits
/// only healthy processors — so binding afterwards would advertise a queue that does not exist yet.
/// </para>
/// </summary>
public sealed class ProcessorStartupOrchestrator : BackgroundService
{
    private readonly IQueueSender _sender;
    private readonly IReplyEndpoint _replies;
    private readonly ReplySlot<object> _slot;
    private readonly ISourceHashProvider _sourceHash;
    private readonly IProcessorContext _context;
    private readonly ProcessorLivenessWriter _writer;
    private readonly InstanceId _instanceId;
    private readonly ProcessorLivenessOptions _options;
    private readonly TimeProvider _clock;
    private readonly ILoopHeartbeat _heartbeat;
    private readonly ILogger<ProcessorStartupOrchestrator> _logger;

    public ProcessorStartupOrchestrator(
        IQueueSender sender,
        IReplyEndpoint replies,
        ReplySlot<object> slot,
        ISourceHashProvider sourceHash,
        IProcessorContext context,
        ProcessorLivenessWriter writer,
        InstanceId instanceId,
        IOptions<ProcessorLivenessOptions> options,
        TimeProvider clock,
        ILoopHeartbeat heartbeat,
        ILogger<ProcessorStartupOrchestrator> logger)
    {
        _sender     = sender ?? throw new ArgumentNullException(nameof(sender));
        _replies    = replies ?? throw new ArgumentNullException(nameof(replies));
        _slot       = slot ?? throw new ArgumentNullException(nameof(slot));
        _sourceHash = sourceHash ?? throw new ArgumentNullException(nameof(sourceHash));
        _context    = context ?? throw new ArgumentNullException(nameof(context));
        _writer     = writer ?? throw new ArgumentNullException(nameof(writer));
        _instanceId = instanceId ?? throw new ArgumentNullException(nameof(instanceId));
        _options    = options?.Value ?? throw new ArgumentNullException(nameof(options));
        _clock      = clock ?? throw new ArgumentNullException(nameof(clock));
        _heartbeat  = heartbeat ?? throw new ArgumentNullException(nameof(heartbeat));
        _logger     = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
        => RunStartupAsync(stoppingToken);

    /// <summary>
    /// Runs both loops to completion and flips the healthy latch. Returns early and without flipping
    /// it if shutdown is requested — a half-resolved processor must never publish itself healthy.
    /// </summary>
    public async Task RunStartupAsync(CancellationToken ct)
    {
        var identity = await ResolveIdentityAsync(ct).ConfigureAwait(false);
        if (identity is null)
        {
            return;   // shutdown
        }

        _context.SetIdentity(identity);
        _logger.LogInformation(
            "identity resolved: processor {ProcessorId} ({Name} {Version})",
            identity.Id, identity.Name, identity.Version);

        // The first post-identity write. From here the replica is visible as unhealthy rather than
        // absent, for as long as it takes Loop B to finish.
        await WriteUnhealthyAsync().ConfigureAwait(false);

        if (!await ResolveDefinitionsAsync(ct).ConfigureAwait(false))
        {
            return;   // shutdown
        }

        _logger.LogInformation("all schema definitions resolved");

        // NOTE: the dispatch endpoint bind belongs here, before the latch flips. See the type remarks.
        _context.MarkHealthy();

        // The loops are finished, so their heartbeat must stop being watched — otherwise it reads as
        // stale one window from now and restarts a perfectly healthy processor.
        _heartbeat.Retire();
        _logger.LogInformation("processor healthy; startup loops retired");
    }

    /// <summary>Loop A. Null means shutdown, never exhaustion.</summary>
    private async Task<ProcessorIdentityFound?> ResolveIdentityAsync(CancellationToken ct)
    {
        var hash = _sourceHash.Get();
        var delay = TimeSpan.FromSeconds(1);

        while (!ct.IsCancellationRequested)
        {
            var reply = await AskAsync(
                ProcessorQueues.IdentityQuery,
                MessageTypes.GetProcessorBySourceHash,
                new GetProcessorBySourceHash(hash),
                ct).ConfigureAwait(false);

            switch (reply)
            {
                case ProcessorIdentityFound found:
                    return found;
                case ProcessorIdentityNotFound:
                    _logger.LogInformation(
                        "no processor registered for source hash {Hash}; retrying in {Delay}", hash, delay);
                    break;
                default:
                    _logger.LogWarning("identity request went unanswered; retrying in {Delay}", delay);
                    break;
            }

            delay = await BackoffAsync(delay, ct).ConfigureAwait(false);
        }

        return null;
    }

    /// <summary>Loop B. False means shutdown.</summary>
    private async Task<bool> ResolveDefinitionsAsync(CancellationToken ct)
    {
        var identity = _context.Identity!;

        // A null id means the role does not apply — a source processor has no input schema — so it is
        // skipped without a request rather than waited on.
        foreach (var schemaId in new[] { identity.InputSchemaId, identity.OutputSchemaId, identity.ConfigSchemaId })
        {
            if (schemaId is not { } id)
            {
                continue;
            }

            var delay = TimeSpan.FromSeconds(1);

            while (true)
            {
                if (ct.IsCancellationRequested)
                {
                    return false;
                }

                // Rewritten each iteration so the L2 summary tracks per-schema progress while any
                // schema is still unresolved. Rides the existing backoff — no extra timer.
                await WriteUnhealthyAsync().ConfigureAwait(false);

                var reply = await AskAsync(
                    ProcessorQueues.SchemaQuery,
                    MessageTypes.GetSchemaDefinition,
                    new GetSchemaDefinition(id),
                    ct).ConfigureAwait(false);

                if (reply is SchemaDefinitionFound found)
                {
                    _context.SetDefinition(id, found.Definition);
                    _logger.LogInformation("definition resolved for schema {SchemaId}", id);
                    break;
                }

                _logger.LogInformation(
                    "schema {SchemaId} not available yet; retrying in {Delay}", id, delay);
                delay = await BackoffAsync(delay, ct).ConfigureAwait(false);
            }
        }

        return true;
    }

    /// <summary>
    /// One ask and its bounded wait. The reply endpoint is ensured live first, on every attempt: the
    /// reply queue dies with its connection, so re-declaring it is how a reconnect is survived, and a
    /// request sent before anyone is listening is answered into nothing.
    /// <para>
    /// The slot is drained before asking. It holds only the newest reply, and a leftover from a
    /// previous attempt would otherwise be mistaken for an answer to this one.
    /// </para>
    /// </summary>
    private async Task<object?> AskAsync(string queue, string type, object body, CancellationToken ct)
    {
        _heartbeat.Beat();

        try
        {
            await _replies.EnsureStartedAsync(ct).ConfigureAwait(false);
            _slot.Take();
            await _sender.SendAsync(queue, type, body, ct, _replies.QueueName).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // A broker that is down or mid-reconnect is the same situation as an unanswered ask: wait
            // and try again. Letting it escape would fault the host over a condition the loop exists
            // to ride out.
            _logger.LogWarning(ex, "could not send the {Type} request; will retry", type);
            return null;
        }

        await _slot.WaitAsync(TimeSpan.FromSeconds(_options.RequestTimeoutSeconds), ct).ConfigureAwait(false);
        return _slot.Take();
    }

    /// <summary>
    /// Publishes the current resolution progress as an unhealthy L2 entry. A null schema id counts as
    /// success (the role does not apply); a non-null id whose definition is still missing counts as a
    /// failure. Any failure makes the entry unhealthy, which is what the orchestration gate reads.
    /// </summary>
    private async Task WriteUnhealthyAsync()
    {
        if (_context.Identity is not { } identity)
        {
            return;   // no processor id yet, so no key to write
        }

        static string Outcome(Guid? id, string? definition) =>
            id is null ? SchemaOutcome.Success
                : definition is null ? SchemaOutcome.Fail
                : SchemaOutcome.Success;

        var entry = ProcessorLivenessEntry.Create(
            inputOutcome:  Outcome(identity.InputSchemaId, identity.InputDefinition),
            outputOutcome: Outcome(identity.OutputSchemaId, identity.OutputDefinition),
            configOutcome: Outcome(identity.ConfigSchemaId, identity.ConfigDefinition),
            timestamp:     _clock.GetUtcNow().UtcDateTime,
            interval:      _options.StartupIntervalSeconds);

        await _writer.WriteAsync(identity.Id, _instanceId.Value, entry).ConfigureAwait(false);
    }

    /// <summary>Waits out the current delay and returns the next one, doubling up to the cap.</summary>
    private async Task<TimeSpan> BackoffAsync(TimeSpan delay, CancellationToken ct)
    {
        try
        {
            await Task.Delay(delay, _clock, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return delay;   // the caller's loop condition sees the cancellation
        }

        return TimeSpan.FromSeconds(
            Math.Min(delay.TotalSeconds * 2, _options.BackoffCapSeconds));
    }
}
