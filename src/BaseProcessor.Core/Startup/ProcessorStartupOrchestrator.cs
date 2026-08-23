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
/// The processor's startup brain: given who this process is, it discovers what its schemas say, and
/// only then declares itself healthy.
/// <list type="number">
///   <item><b>Loop B</b> — resolve the definition behind each non-null schema id, retrying forever.</item>
/// </list>
/// <para>
/// <b>Identity is resolved before this host exists.</b> What used to be Loop A now runs as Stage 1 of
/// the two-stage boot, because an OpenTelemetry resource freezes when its provider is built and a
/// row-derived identity can only ride it by being known first. The container arrives pre-seeded —
/// see <c>AddBaseProcessor(cfg, identity)</c> — so this class begins at Loop B.
/// </para>
/// <para>
/// <b>Loop B retries without limit, and that is the requirement rather than a fallback.</b> A
/// processor image can be deployed before its schema rows exist, so "not found" is a normal early
/// answer, not an error — a bounded retry would turn an ordering the operator is allowed to choose
/// into a crash loop. Only shutdown ends it.
/// </para>
/// <para>
/// <b>The replica is published to L2 as unhealthy from the moment startup begins</b>, and rewritten
/// on every Loop B iteration as per-schema progress advances. That is what makes a still-starting
/// replica visible as <c>unhealthy</c> rather than <c>absent</c>: both block the orchestration gate,
/// but only one of them says why.
/// </para>
/// <para>
/// <b>The recorded interval on those writes is the startup anchor, not the heartbeat cadence.</b>
/// These writes ride the retry backoff, so at the cap the gap between two of them reaches
/// <c>BackoffCap + RequestTimeout</c>; recording the 10s steady-state interval would derive a TTL
/// shorter than that gap and let a replica expire its own key between its own writes.
/// </para>
/// <para>
/// <b>The dispatch endpoint's binding is NOT sequenced against <c>MarkHealthy</c> today, in either
/// direction.</b> This paragraph used to require binding before the latch flips, on the reasoning
/// that the heartbeat publishes <c>Healthy</c> to L2 only once it does and the orchestrator admits
/// only healthy processors, so binding afterwards would advertise a queue nobody is serving. That
/// requirement is real but unmet: <c>GatedQueueConsumer</c> is a <c>BackgroundService</c> that begins
/// consuming as soon as the L2 gate opens, and nothing consults <see cref="IProcessorContext.IsHealthy"/>
/// before it does — so the queue is in fact bound <i>before</i> this loop finishes, and a dispatch can
/// arrive while the definitions are still unresolved. Both message handlers park such a dispatch
/// rather than run it unvalidated. Gating consumption on health is the proper fix; it is recorded as
/// a known gap in the execution-path plan.
/// </para>
/// </summary>
public sealed class ProcessorStartupOrchestrator : BackgroundService
{
    private readonly IQueueSender _sender;
    private readonly IReplyEndpoint _replies;
    private readonly ReplySlot<object> _slot;
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
    /// Resolves the schema definitions for an identity that is already in hand, then flips the healthy
    /// latch. Returns early and without flipping it if shutdown is requested — a half-resolved
    /// processor must never publish itself healthy.
    /// </summary>
    public async Task RunStartupAsync(CancellationToken ct)
    {
        // Identity arrived before this host existed: Stage 1 resolved it so the OTel resource could
        // carry it, and the container was seeded with the answer. What used to be Loop A is gone.
        _ = _context.Identity
            ?? throw new InvalidOperationException(
                "the orchestrator started without a seeded identity — AddBaseProcessor(cfg, identity) " +
                "is what supplies it, and the two-stage boot is what calls that overload.");

        // The first write. From here the replica is visible as unhealthy rather than absent, for as
        // long as it takes Loop B to finish.
        await WriteUnhealthyAsync().ConfigureAwait(false);

        if (!await ResolveDefinitionsAsync(ct).ConfigureAwait(false))
        {
            return;   // shutdown
        }

        _logger.LogInformation("all schema definitions resolved");

        // NOTE: the dispatch endpoint bind belongs here, before the latch flips. See the type remarks.
        _context.MarkHealthy();

        // The loop is finished, so its heartbeat must stop being watched — otherwise it reads as stale
        // one window from now and restarts a perfectly healthy processor.
        _heartbeat.Retire();
        _logger.LogInformation("processor healthy; startup loops retired");
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

        // One fresh id per REQUEST, not per loop: a retry is a new question, and reusing an id would
        // make two records that an operator has to tell apart look like one. The serving side echoes
        // it onto the reply and names it at every drop and failure site, so this record is the other
        // half of that pair — without it those RPC diagnostics point at nothing. "N" is the fixed
        // rendering for a correlation id everywhere in this stack.
        //
        // Guid.NewGuid is banned under Processing/, where a redelivery must replay the same ids. This
        // is a startup query with no replay semantics at all, so a fresh guid is exactly right.
        var correlationId = Guid.NewGuid().ToString("N");

        try
        {
            await _replies.EnsureStartedAsync(ct).ConfigureAwait(false);
            _slot.Take();
            await _sender
                .SendAsync(queue, type, body, ct, _replies.QueueName, correlationId)
                .ConfigureAwait(false);
            _logger.LogInformation("asked {Type} {CorrelationId}", type, correlationId);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // A broker that is down or mid-reconnect is the same situation as an unanswered ask: wait
            // and try again. Letting it escape would fault the host over a condition the loop exists
            // to ride out.
            var verdict = BrokerFaultClassifier.Classify(ex);
            _logger.LogWarning(
                ex, "could not send the {Type} request; will retry {CorrelationId} [{Fault}]: {Reason}",
                type, correlationId, verdict.Fault, verdict.Reason);
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
