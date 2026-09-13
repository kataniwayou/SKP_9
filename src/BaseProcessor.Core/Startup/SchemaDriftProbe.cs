using BaseConsole.Core.Health;
using BaseConsole.Core.Messaging;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Identity;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace BaseProcessor.Core.Startup;

/// <summary>
/// Re-asks for this processor's registered identity on a timer and reports when its schema edges have
/// moved away from the ones this replica resolved at boot.
///
/// <para>
/// <b>THE SITUATION IT EXISTS FOR.</b> A schema edge is a row id on the shared processor row, and
/// re-pointing it is routine. A running pod resolved its definitions in Loop B, at boot, and never
/// looks again — so between a re-point and a restart the PUBLISHED contract and the ENFORCED contract
/// differ, and every log line in that window looks healthy. Observed on 2026-09-12: both sides of an
/// edge were moved to a tightened schema, the workflow started, and a document violating it completed
/// the chain end to end. Nothing was wrong with the validation; the pods were enforcing what they had
/// cached, and nothing said so.
/// </para>
///
/// <para>
/// <b>IT WARNS. IT DOES NOT ACT, AND THE RESTRAINT IS THE DESIGN.</b> Two louder responses were
/// available and both are worse:
/// </para>
/// <para>
/// <i>Going unhealthy</i> is not expressible. <c>MarkHealthy</c> is one-way — an
/// <c>Interlocked.Exchange</c> to 1 with no counterpart — and the work-queue consumer opens once and
/// never closes, so there is no supported "stop serving" state to enter. Inventing one here would be
/// a far larger change than this gap, and it would hand a transient identity-RPC failure the power to
/// take a healthy fleet out of service.
/// </para>
/// <para>
/// <i>Re-resolving in place</i> is worse than the problem. It would change what validates a document
/// mid-flight, so two documents in one batch could be judged against different contracts with nothing
/// recording which — trading a diagnosable divergence for an undiagnosable one. The whole point of
/// resolving at boot is that a replica's contract is fixed for its lifetime.
/// </para>
/// <para>
/// So the answer is the one the gap actually asked for: say it, name both ids, and say what applies
/// the change. A restart is the mechanism, and it is an operator's decision, not this loop's.
/// </para>
///
/// <para>
/// <b>It repeats while the divergence lasts</b>, rather than warning once. A single line at an
/// arbitrary moment cannot be alerted on; a line every interval can, and the condition is not
/// self-healing, so the repetition is signal rather than noise.
/// </para>
/// </summary>
/// <remarks>
/// Shares the singleton <see cref="ReplySlot{T}"/> with the startup orchestrator's asks. That is safe
/// because the orchestrator retires before this loop begins — it waits on the same gate that the
/// orchestrator's <c>MarkHealthy</c> opens — so the two never have a request in flight at once. A
/// third asker added later would need its own slot.
/// </remarks>
public sealed class SchemaDriftProbe : BackgroundService
{
    private readonly IQueueSender _sender;
    private readonly IReplyEndpoint _replies;
    private readonly ReplySlot<object> _slot;
    private readonly IProcessorContext _context;
    private readonly ISourceHashProvider _sourceHash;
    private readonly IStartupGate _gate;
    private readonly ProcessorLivenessOptions _options;
    private readonly TimeProvider _clock;
    private readonly ILogger<SchemaDriftProbe> _logger;

    public SchemaDriftProbe(
        IQueueSender sender,
        IReplyEndpoint replies,
        ReplySlot<object> slot,
        IProcessorContext context,
        ISourceHashProvider sourceHash,
        IStartupGate gate,
        IOptions<ProcessorLivenessOptions> options,
        TimeProvider clock,
        ILogger<SchemaDriftProbe> logger)
    {
        _sender     = sender ?? throw new ArgumentNullException(nameof(sender));
        _replies    = replies ?? throw new ArgumentNullException(nameof(replies));
        _slot       = slot ?? throw new ArgumentNullException(nameof(slot));
        _context    = context ?? throw new ArgumentNullException(nameof(context));
        _sourceHash = sourceHash ?? throw new ArgumentNullException(nameof(sourceHash));
        _gate       = gate ?? throw new ArgumentNullException(nameof(gate));
        _options    = options?.Value ?? throw new ArgumentNullException(nameof(options));
        _clock      = clock ?? throw new ArgumentNullException(nameof(clock));
        _logger     = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Zero disables it entirely. An operator who does not want a periodic identity query on this
        // processor's behalf gets to say so without removing the registration.
        if (_options.SchemaDriftCheckSeconds <= 0)
        {
            _logger.LogInformation("schema drift checking is disabled (SchemaDriftCheck=0)");
            return;
        }

        var period = TimeSpan.FromSeconds(_options.SchemaDriftCheckSeconds);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(period, _clock, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;   // host shutdown
            }

            // Not before the replica is serving. Loop B is still asking on the shared slot until the
            // gate opens, and a second asker on it would cross their replies.
            if (!_gate.IsReady)
            {
                continue;
            }

            await CheckOnceAsync(stoppingToken).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// One comparison. Returns true when the registered edges differ from the resolved ones.
    /// <para>
    /// Public and separate from the loop so a test can make the assertion without driving a timer —
    /// a <c>FakeTimeProvider</c> only advances when something reads it, and a loop test that has to
    /// pump it externally proves the pump more than it proves this.
    /// </para>
    /// </summary>
    public async Task<bool> CheckOnceAsync(CancellationToken ct)
    {
        if (_context.Identity is not { } resolved)
        {
            return false;
        }

        var reply = await AskAsync(ct).ConfigureAwait(false);

        switch (reply)
        {
            case ProcessorIdentityFound registered:
                return Compare(resolved, registered);

            case ProcessorIdentityNotFound:
                // The row this replica registered against is gone or its hash was re-pointed
                // elsewhere. It keeps serving on what it has, which is why this is worth saying.
                _logger.LogWarning(
                    "this replica's processor row is no longer registered under its source hash; it "
                    + "keeps enforcing the schemas it resolved at boot until it restarts");
                return true;

            default:
                // An unanswered ask is a broker or API problem, not drift. Saying nothing is right:
                // the reply endpoint and the queue-depth probes already report that condition, and a
                // warning here would blame the schemas for a transport fault.
                return false;
        }
    }

    /// <summary>Compares the three edges and reports each one that moved.</summary>
    private bool Compare(ProcessorIdentity resolved, ProcessorIdentityFound registered)
    {
        var drifted = false;

        drifted |= Report("input", resolved.InputSchemaId, registered.InputSchemaId);
        drifted |= Report("output", resolved.OutputSchemaId, registered.OutputSchemaId);
        drifted |= Report("config", resolved.ConfigSchemaId, registered.ConfigSchemaId);

        return drifted;
    }

    private bool Report(string role, Guid? resolved, Guid? registered)
    {
        if (resolved == registered)
        {
            return false;
        }

        // BOTH IDS, because neither alone is actionable: the registered one says what the workflow
        // was published against and the resolved one says what this replica is actually applying, and
        // the fix is to make them agree in whichever direction the operator intended.
        _logger.LogWarning(
            "the registered {Role} schema has changed since this replica resolved it: enforcing "
            + "{ResolvedSchemaId}, registered is {RegisteredSchemaId} — this replica keeps enforcing "
            + "what it resolved at boot, and only a restart applies the change",
            role, resolved, registered);

        return true;
    }

    /// <summary>
    /// One ask and its bounded wait, mirroring the startup orchestrator's: the reply endpoint is
    /// ensured live on every attempt because the queue dies with its connection, and the slot is
    /// drained first so a leftover cannot be mistaken for this answer.
    /// </summary>
    private async Task<object?> AskAsync(CancellationToken ct)
    {
        var correlationId = Guid.NewGuid().ToString("N");

        try
        {
            await _replies.EnsureStartedAsync(ct).ConfigureAwait(false);
            _slot.Take();
            await _sender.SendAsync(
                ProcessorQueues.IdentityQuery,
                MessageTypes.GetProcessorBySourceHash,
                new GetProcessorBySourceHash(_sourceHash.Get()),
                ct,
                _replies.QueueName,
                correlationId).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Information, not Warning. This loop is a diagnostic: a broker blip while it asks is not
            // a fault of the processor's work, and logging it at the severity an operator filters on
            // would make a periodic query into a periodic alarm.
            _logger.LogInformation(
                "could not ask for the registered identity {CorrelationId}: {Reason}",
                correlationId, ex.Message);

            return null;
        }

        await _slot.WaitAsync(TimeSpan.FromSeconds(_options.RequestTimeoutSeconds), ct).ConfigureAwait(false);
        return _slot.Take();
    }
}
