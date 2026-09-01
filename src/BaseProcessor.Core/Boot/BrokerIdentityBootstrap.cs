using BaseConsole.Core.DependencyInjection;
using BaseConsole.Core.Messaging;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Identity;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace BaseProcessor.Core.Boot;

/// <summary>
/// Stage 1 over the real broker. It stands up the smallest container that can ask a question —
/// connection, sender, reply queue, slot — asks it until answered, and takes the whole thing down
/// again.
/// <para>
/// <b>The container is disposed before the host builds its own.</b> The two connections never
/// overlap. Handing this one across would save a reconnect and cost a lifetime that spans two
/// containers, and the reply queue is exclusive and auto-delete precisely so that dropping the
/// connection cleans up after itself.
/// </para>
/// <para>
/// <b>Redis is deliberately absent.</b> Nothing is written to L2 before identity resolves — there is
/// no processor id to key on — so requiring a store here would add a dependency to the one window
/// that must be able to wait out everything else.
/// </para>
/// </summary>
public sealed class BrokerIdentityBootstrap : IIdentityBootstrap, IAsyncDisposable
{
    private readonly ServiceProvider _services;
    private readonly ILogger<BrokerIdentityBootstrap> _logger;
    private readonly TimeProvider _clock;

    /// <param name="sourceHash">
    /// The code identity to ask about. Null takes the default, which reads the hash embedded on the
    /// entry assembly — a value only a concrete processor's build emits. Overriding it is what makes
    /// the loop reachable at all from anything that is not itself a processor.
    /// </param>
    public BrokerIdentityBootstrap(
        IConfiguration cfg,
        ILoggerFactory logs,
        TimeProvider clock,
        ISourceHashProvider? sourceHash = null)
    {
        ArgumentNullException.ThrowIfNull(cfg);
        ArgumentNullException.ThrowIfNull(logs);
        ArgumentNullException.ThrowIfNull(clock);

        _clock  = clock;
        _logger = logs.CreateLogger<BrokerIdentityBootstrap>();

        // Bound through the same type the host binds, rather than by reading the keys directly. The
        // keys are not the property names — ConfigurationKeyName shortens them — so restating either
        // the keys or the defaults here would be a second copy free to drift, and the drift would
        // show up only as the boot ignoring a knob the operator had already tuned.
        var options = cfg.GetSection("Processor").Get<ProcessorLivenessOptions>()
            ?? new ProcessorLivenessOptions();

        RequestTimeoutSeconds = options.RequestTimeoutSeconds;
        BackoffCapSeconds     = options.BackoffCapSeconds;

        var services = new ServiceCollection();
        services.AddSingleton(logs);
        services.AddLogging();
        // Reuses the console registration rather than restating it, so the boot connects with exactly
        // the settings the host will use — including the eager Require checks that name a missing key.
        services.AddBaseConsoleMessaging(cfg);
        services.AddSingleton(InstanceId.Resolve());
        services.AddSingleton<ReplySlot<object>>();
        services.AddSingleton<ReplyQueueConsumer>();
        services.AddSingleton<IReplyEndpoint>(sp => sp.GetRequiredService<ReplyQueueConsumer>());
        if (sourceHash is null)
        {
            services.AddSingleton<ISourceHashProvider, AssemblyMetadataSourceHashProvider>();
        }
        else
        {
            services.AddSingleton(sourceHash);
        }

        _services = services.BuildServiceProvider();
    }

    /// <summary>
    /// How long the loop waits before an unanswered ask stops reading as a normal startup race and
    /// starts reading as an incident.
    /// <para>
    /// <b>A log level, never a behaviour change.</b> The loop still waits forever either way — that
    /// tolerance is the whole point of the design, and an operator deploying the services in any
    /// order depends on it. What changes at this threshold is only how the line reads, because a
    /// wait of three seconds and a wait of three hours are the same sentence otherwise, and only one
    /// of them is worth waking someone for.
    /// </para>
    /// </summary>
    private static readonly TimeSpan EscalateAfter = TimeSpan.FromSeconds(60);

    /// <summary>How long one ask waits for its reply before the loop treats it as unanswered.</summary>
    public int RequestTimeoutSeconds { get; }

    /// <summary>The ceiling the retry delay doubles towards.</summary>
    public int BackoffCapSeconds { get; }

    /// <inheritdoc/>
    public async Task<ProcessorIdentityFound> ResolveAsync(CancellationToken ct)
    {
        var hash    = _services.GetRequiredService<ISourceHashProvider>().Get();
        var sender  = _services.GetRequiredService<IQueueSender>();
        var replies = _services.GetRequiredService<IReplyEndpoint>();
        var slot    = _services.GetRequiredService<ReplySlot<object>>();
        var delay   = TimeSpan.FromSeconds(1);

        // Read once, before the first ask, so every line below reports the wait as the operator
        // experiences it — from the moment the processor started asking, not from the last attempt.
        var since = _clock.GetUtcNow();

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            var reply = await AskAsync(sender, replies, slot, hash, ct).ConfigureAwait(false);

            // One read per pass, shared by both waiting branches: two reads would let the two lines
            // of a single pass disagree, and under a FakeTimeProvider a read is also what advances
            // the clock at all.
            var elapsed   = _clock.GetUtcNow() - since;
            var escalated = elapsed >= EscalateAfter;

            // Truncated to whole seconds for the log only, never for the comparison above. "c" on a
            // raw TimeSpan renders 00:00:08.1062769, and seven decimal places of precision on a
            // number an operator reads as "how long has this been stuck" is noise sitting exactly
            // where the answer should be.
            var waited = TimeSpan.FromSeconds(Math.Floor(elapsed.TotalSeconds));

            switch (reply)
            {
                case ProcessorIdentityFound found:
                    _logger.LogInformation(
                        "identity resolved: processor {ProcessorId} ({Name} {Version})",
                        found.Id, found.Name, found.Version);
                    return found;

                // The API answered and said no. Nothing is broken in the deployment — the row this
                // build's hash names has not been registered — so the remedy names the hash rather
                // than a service.
                case ProcessorIdentityNotFound when escalated:
                    _logger.LogError(
                        "still no processor registered for source hash {Hash} after {Waited:c}; "
                        + "register a processor against this hash, or deploy the build whose hash is "
                        + "already registered. retrying in {Delay}",
                        hash, waited, delay);
                    break;
                case ProcessorIdentityNotFound:
                    _logger.LogInformation(
                        "no processor registered for source hash {Hash} after {Waited:c}; "
                        + "retrying in {Delay}",
                        hash, waited, delay);
                    break;

                // Nobody answered at all. THIS is the branch a processor deployed before the API
                // sits in, and the queue and its server are named here because they are the whole
                // remedy: without them the line reports a symptom the operator cannot act on, and
                // the fact that this queue is the API's is visible only in the API's own log.
                default:
                    if (escalated)
                    {
                        _logger.LogError(
                            "nothing has answered on {Queue} for {Waited:c} — that queue is served by "
                            + "the BaseApi service (deployment baseapi-service); check that it is "
                            + "deployed and running. retrying in {Delay}",
                            ProcessorQueues.IdentityQuery, waited, delay);
                    }
                    else
                    {
                        _logger.LogWarning(
                            "nothing answered on {Queue} after {Waited:c} — that queue is served by "
                            + "the BaseApi service (deployment baseapi-service), which may not be up "
                            + "yet. retrying in {Delay}",
                            ProcessorQueues.IdentityQuery, waited, delay);
                    }

                    break;
            }

            // Task.Delay(delay, clock, ct) rather than an instance method — this is the form the
            // orchestrator's own BackoffAsync already uses, and TimeProvider has no Delay of its own.
            await Task.Delay(delay, _clock, ct).ConfigureAwait(false);
            delay = TimeSpan.FromSeconds(
                Math.Min(delay.TotalSeconds * 2, BackoffCapSeconds));
        }
    }

    /// <summary>
    /// One ask and its bounded wait, mirroring the orchestrator's: the reply endpoint is ensured live
    /// on every attempt because the queue dies with its connection, and the slot is drained first so a
    /// leftover from a previous attempt cannot be mistaken for this one's answer.
    /// </summary>
    private async Task<object?> AskAsync(
        IQueueSender sender, IReplyEndpoint replies, ReplySlot<object> slot, string hash,
        CancellationToken ct)
    {
        // One fresh id per request, the same as the startup orchestrator's ask. The serving side
        // echoes it onto the reply and names it at every drop and failure site, and those query
        // queues have no dead-letter exchange — a log record at each end carrying this id is the only
        // way an unanswered identity query can be traced to the loop still asking for it. Guid.NewGuid
        // is banned only under Processing/, where a redelivery must replay the same ids; a boot-time
        // query has no replay semantics.
        var correlationId = Guid.NewGuid().ToString("N");

        try
        {
            await replies.EnsureStartedAsync(ct).ConfigureAwait(false);
            slot.Take();
            await sender.SendAsync(
                ProcessorQueues.IdentityQuery,
                MessageTypes.GetProcessorBySourceHash,
                new GetProcessorBySourceHash(hash),
                ct,
                replies.QueueName,
                correlationId).ConfigureAwait(false);
            // "request {id}", never "the identity {id}": the value is this ask's correlation id, and
            // the previous wording read as though the GUID were the processor's identity — which
            // changed on every retry, so a waiting operator watched an identity that never settled.
            _logger.LogInformation(
                "identity request {CorrelationId} sent to {Queue}",
                correlationId, ProcessorQueues.IdentityQuery);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // A broker that is down or mid-reconnect is the same situation as an unanswered ask: wait
            // and try again. This is the window the design exists to let a processor ride out.
            var verdict = BrokerFaultClassifier.Classify(ex);
            _logger.LogWarning(
                ex, "could not send the identity request; will retry {CorrelationId} [{Fault}]: {Reason}",
                correlationId, verdict.Fault, verdict.Reason);
            return null;
        }

        await slot.WaitAsync(TimeSpan.FromSeconds(RequestTimeoutSeconds), ct).ConfigureAwait(false);
        return slot.Take();
    }

    public async ValueTask DisposeAsync()
    {
        if (_services.GetService<ReplyQueueConsumer>() is { } consumer)
        {
            await consumer.DisposeAsync().ConfigureAwait(false);
        }

        await _services.DisposeAsync().ConfigureAwait(false);
    }
}
