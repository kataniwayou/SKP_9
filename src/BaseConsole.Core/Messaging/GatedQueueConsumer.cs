using System.Diagnostics;
using BaseConsole.Core.Gating;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;
using RabbitMQ.Client.Exceptions;

namespace BaseConsole.Core.Messaging;

/// <summary>
/// Consumes a queue only while the projection store is usable, and stops consuming — at the broker,
/// not by failing messages — while it is not.
/// <para>
/// <b>Pausing at the broker is the point.</b> The alternative, letting messages arrive and fail,
/// burns a redelivery per message per attempt for the whole outage and eventually parks work that was
/// never wrong. Cancelling the subscription leaves everything on the queue, costing nothing, for as
/// long as the outage lasts.
/// </para>
/// <para>
/// <b>State is reconciled, not applied on edges.</b> A gate change signals this loop; the loop then
/// compares what it should be doing against what it is doing and closes the difference. An edge that
/// is missed, or whose broker call fails, is picked up by the next pass — where an apply-on-edge
/// design has to notice the failure and remember to retry it, which is where that design usually
/// breaks: a skipped action gets recorded as an applied one and the consumer never starts again.
/// </para>
/// <para>
/// <b>Delivery tags are only valid within one epoch.</b> A channel failure or an automatic recovery
/// renumbers deliveries, and acknowledging a tag from before that point is a channel-level error that
/// closes the channel for good — converting a transient blip into a consumer that is silently dead.
/// Every acknowledgement is therefore checked against the epoch its delivery arrived in.
/// </para>
/// <para>
/// <b>Consuming also requires admission, a second and separate condition from the L2 gate.</b>
/// <see cref="IConsumerAdmission"/> is one-shot readiness — a host opens it once its own startup work
/// is done and never closes it again — where the L2 gate is dynamic and reopens as the projection
/// store comes and goes. The two are independent axes of the same decision, not two names for one
/// thing.
/// </para>
/// </summary>
public sealed class GatedQueueConsumer : BackgroundService
{
    private readonly RabbitMqConnection _connection;
    private readonly L2Gate _gate;
    private readonly IServiceScopeFactory _scopes;
    private readonly GatedConsumerOptions _options;
    private readonly IConsumerAdmission _admission;
    private readonly ILogger<GatedQueueConsumer> _logger;

    // Initial count 0, maximum 1: a signal arriving while one is already pending is absorbed, because
    // the loop reconciles against current state rather than replaying a queue of edges.
    private readonly SemaphoreSlim _wake = new(0, 1);

    private IChannel? _channel;
    private AsyncEventingBasicConsumer? _consumer;
    private IConnection? _subscribedConnection;
    private volatile string? _consumerTag;
    private volatile bool _channelUsable;
    private long _epoch;

    public GatedQueueConsumer(
        RabbitMqConnection connection,
        L2Gate gate,
        IServiceScopeFactory scopes,
        IOptions<GatedConsumerOptions> options,
        IConsumerAdmission admission,
        ILogger<GatedQueueConsumer> logger)
    {
        _connection = connection ?? throw new ArgumentNullException(nameof(connection));
        _gate       = gate ?? throw new ArgumentNullException(nameof(gate));
        _scopes     = scopes ?? throw new ArgumentNullException(nameof(scopes));
        _options    = options?.Value ?? throw new ArgumentNullException(nameof(options));
        _admission  = admission ?? throw new ArgumentNullException(nameof(admission));
        _logger     = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>Whether the consumer currently holds a subscription to the queue.</summary>
    public bool IsConsuming => _consumerTag is not null;

    /// <summary>Whether the channel is in a state where consuming is possible at all.</summary>
    public bool IsChannelUsable => _channelUsable;

    /// <summary>
    /// Whether the consumer should currently hold a subscription: admission is granted and the L2 gate
    /// is open. A single named member rather than an inline local so there is exactly one place this
    /// conjunction lives, and one place a test can reach it.
    /// </summary>
    internal bool ShouldConsume => _admission.IsOpen && _gate.IsOpen;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _gate.StateChanged += OnGateChanged;

        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    await ConvergeAsync(stoppingToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception ex)
                {
                    // Never end the loop on a failure to converge — the broker may simply be down.
                    // The next pass retries, and until then the consumer stays in whatever state it
                    // already held, which is safe in both directions.
                    //
                    // The fault kind is one word rather than the verdict's full guidance sentence, and
                    // that is a decision about volume: a live run emitted this line 187 times in an
                    // hour, and 187 copies of "no action needed — this clears when the dependency
                    // returns..." is a flood that buries the reason it accompanies. One word answers
                    // the only question being asked here — do I need to act — and the preflight loop,
                    // which logs far less often, still renders the guidance in full.
                    var verdict = BrokerFaultClassifier.Classify(ex);
                    _logger.LogWarning(
                        ex, "consumer for {Queue} could not converge [{Fault}]: {Reason}",
                        _options.Queue, verdict.Fault, verdict.Reason);
                }

                await WaitForSignalAsync(stoppingToken).ConfigureAwait(false);
            }
        }
        finally
        {
            _gate.StateChanged -= OnGateChanged;
        }
    }

    /// <summary>
    /// Signal only — no broker calls, nothing awaited. This runs inside the gate's mutex, so anything
    /// slower than a flag flip would stall every other caller of the gate, including the probe loop
    /// whose continued ticking is what proves this process is alive.
    /// </summary>
    private void OnGateChanged(bool open)
    {
        try
        {
            _wake.Release();
        }
        catch (SemaphoreFullException)
        {
            // A signal is already pending, and one is as good as two: the loop reads current state.
        }
    }

    private async Task WaitForSignalAsync(CancellationToken ct)
    {
        try
        {
            await _wake.WaitAsync(_options.ConvergeInterval, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Shutdown. The caller's loop condition ends the loop.
        }
    }

    /// <summary>
    /// Brings actual state in line with the gate: a usable channel, and a subscription that exists
    /// exactly when the gate is open.
    /// </summary>
    private async Task ConvergeAsync(CancellationToken ct)
    {
        if (!_channelUsable)
        {
            await OpenChannelAsync(ct).ConfigureAwait(false);
        }

        if (!_channelUsable || _channel is null || _consumer is null)
        {
            return;   // the broker is unreachable; the next pass tries again
        }

        var shouldConsume = ShouldConsume;

        if (shouldConsume && _consumerTag is null)
        {
            _consumerTag = await _channel
                .BasicConsumeAsync(_options.Queue, autoAck: false, _consumer, ct)
                .ConfigureAwait(false);

            // Both conditions are named because both are read: this transition fires on the
            // ShouldConsume conjunction, and on a host that gates admission the first one of these a
            // process ever logs is admission opening, not the store coming back. A message naming
            // only the store would send an operator to Redis for a change Redis had no part in.
            _logger.LogInformation(
                "consumption admitted and the projection store healthy — consuming {Queue}",
                _options.Queue);
        }
        else if (!shouldConsume && _consumerTag is not null)
        {
            var tag = _consumerTag;
            _consumerTag = null;

            // noWait: the confirmation would be delivered through the same dispatcher a handler may
            // currently occupy, and waiting for it there is a deadlock at a dispatch concurrency of
            // one. Nothing depends on the confirmation — the next pass re-checks.
            await _channel.BasicCancelAsync(tag, noWait: true, ct).ConfigureAwait(false);

            // The disjunction, for the same reason, and no narrower: this pass knows the conjunction
            // no longer holds, not which half of it gave way.
            _logger.LogWarning(
                "consumption no longer admitted or the projection store unhealthy — paused consuming {Queue}",
                _options.Queue);
        }
    }

    /// <summary>
    /// Opens a fresh channel and attaches a consumer to it. It does not declare the queue: topology
    /// is established when the connection opens, precisely so a paused consumer cannot leave a queue
    /// undeclared while senders are still addressing it.
    /// </summary>
    private async Task OpenChannelAsync(CancellationToken ct)
    {
        await DiscardChannelAsync().ConfigureAwait(false);

        var connection = await _connection.GetAsync(ct).ConfigureAwait(false);

        if (!ReferenceEquals(_subscribedConnection, connection))
        {
            if (_subscribedConnection is not null)
            {
                _subscribedConnection.RecoverySucceededAsync -= OnRecoveredAsync;
            }

            connection.RecoverySucceededAsync += OnRecoveredAsync;
            _subscribedConnection = connection;
        }

        var channel = await connection.CreateChannelAsync(cancellationToken: ct).ConfigureAwait(false);
        channel.ChannelShutdownAsync += OnChannelShutdownAsync;

        await channel.BasicQosAsync(
                prefetchSize: 0, prefetchCount: _options.PrefetchCount, global: false, ct)
            .ConfigureAwait(false);

        var consumer = new AsyncEventingBasicConsumer(channel);
        consumer.ReceivedAsync += OnReceivedAsync;

        _channel = channel;
        _consumer = consumer;
        _consumerTag = null;

        // A new channel means new delivery numbering; anything captured against the old one is void.
        Interlocked.Increment(ref _epoch);
        _channelUsable = true;
    }

    /// <summary>
    /// One delivery, start to finish. <c>internal</c> rather than <c>private</c> so the disposition
    /// matrix can be driven without a broker — the same reason <see cref="ShouldConsume"/> is.
    /// <para>
    /// <b>Exactly one <c>RecordConsumed</c> per exit path, and they all live here.</b> Recording
    /// inside <see cref="SafeAckAsync"/> and <see cref="SafeNackAsync"/> instead would put the
    /// increment in two places, and "exactly once per delivery" would become a rule to remember
    /// rather than something you can see by reading one method.
    /// </para>
    /// <para>
    /// <b>The outer catch measures escapes without changing them.</b> This method is a RabbitMQ
    /// <c>ReceivedAsync</c> callback, so the client library swallows whatever escapes it — silently,
    /// in exactly the shutdown-and-outage window this instrument exists to cover. Every branch above
    /// records through the local <c>Record</c> function before it returns; if execution reaches the
    /// outer catch with nothing recorded, one of those branches never got the chance to. The catch
    /// records that as <c>reason="escaped"</c> and then rethrows unconditionally — this method must
    /// not change what escapes the callback, only measure it on the way out.
    /// </para>
    /// </summary>
    internal async Task OnReceivedAsync(object sender, BasicDeliverEventArgs ea)
    {
        var epoch = Interlocked.Read(ref _epoch);
        var recorded = false;
        var type = "";

        var started = Stopwatch.GetTimestamp();

        // The value the outer catch's path carries. Every branch that calls Record overwrites it,
        // so this is only ever read for a delivery that escaped classification entirely. Seeded
        // to "requeued" — not "escaped" — because that is the disposition the outer catch actually
        // records via RecordConsumed below ("requeued", "escaped"); "escaped" is a reason, not a
        // disposition, and pipeline.consumer.duration must agree with pipeline.messages.consumed
        // about what happened to the same delivery.
        var disposition = "requeued";

        // Every branch below calls this instead of IngressMetrics.RecordConsumed directly, so the
        // outer catch can tell whether one of them already recorded before it adds its own.
        void Record(string d, string reason)
        {
            recorded = true;
            disposition = d;
            IngressMetrics.RecordConsumed(_options.Queue, type, d, reason);
        }

        try
        {
            type = ea.BasicProperties.Type ?? "";

            // Read before the gate check below, so a message requeued by a closed gate still
            // contributes its wait -- a delivery that bounced off a shut gate WAITED, and dropping
            // it would make the queue look fastest exactly while the pipeline was stopped.
            var headers  = ea.BasicProperties.Headers;
            var sentMs   = MessageClock.ReadHeader(headers, MessageClock.SentHeader);
            var originMs = MessageClock.ReadHeader(headers, MessageClock.OriginHeader);

            IngressMetrics.RecordArrival(_options.Queue, sentMs);

            // Adopt this delivery's chain for everything the handler goes on to do. The ambient
            // flows into the handler's sends, so a message caused by this one carries the ORIGINAL
            // step's origin rather than the moment it was published -- which is what makes the
            // orchestrator's view of a step's outcome a door-to-door measurement.
            //
            // Set here rather than beside the handler invocation because a requeue is also a
            // consequence of this delivery, and the redelivery's own headers will re-establish it.
            MessageClock.Adopt(originMs);

            // The gate can close between the broker handing this message over and it arriving here, and
            // messages already in flight when the subscription was cancelled still arrive. Re-checking
            // here is what makes a pause clean rather than a burst of failures.
            if (!_gate.IsOpen)
            {
                // Result discarded: nothing downstream distinguishes a landed nack from a lost one
                // on this path (unlike the park branch below, which logs on it).
                _ = await SafeNackAsync(ea, requeue: true, epoch).ConfigureAwait(false);
                Record("requeued", "gate_closed");
                return;
            }

            // Copy out of the transport buffer, which is pooled and valid only for this callback.
            var body = ea.Body.ToArray();

            // Debug, and it stays Debug however useful it looks. This runs ABOVE the deserialization
            // boundary, so the ids that make a record joinable — correlation, workflow, step — are still
            // bytes here and cannot be put on it. A per-delivery Information record that carries only a
            // queue name would double the log volume of every run while answering none of the questions
            // the ids answer. The handlers log their own entry one layer down, inside the scope where
            // those ids exist, and that is the record worth shipping.
            _logger.LogDebug("received a {Type} delivery on {Queue}", type, _options.Queue);

            try
            {
                if (string.IsNullOrWhiteSpace(type))
                {
                    throw new InvalidOperationException("message carries no type header");
                }

                await using var scope = _scopes.CreateAsyncScope();
                var handler = scope.ServiceProvider
                    .GetServices<IQueueMessageHandler>()
                    .SingleOrDefault(h => h.MessageType == type);

                if (handler is null)
                {
                    // Unknown type. Retrying cannot help — no redeploy of this process grows a handler
                    // for it — so park it, where it survives for inspection.
                    throw new InvalidOperationException("no handler is registered for this message type");
                }

                // Deliberately not the delivery's own token: cancelling mid-handler would abandon a
                // partially applied write with the message already claimed. Shutdown lets in-flight work
                // finish and leaves unacknowledged deliveries to be redelivered.
                await handler.HandleAsync(body, CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                switch (DeliveryClassifier.Classify(ex))
                {
                    case DeliveryDisposition.RequeueAndTrip:
                    {
                        _logger.LogWarning(
                            ex, "projection store unreachable — returning message to {Queue}", _options.Queue);

                        // Awaited rather than fired and forgotten: closing the gate before the message goes
                        // back means the redelivery finds it already closed instead of racing it. That is
                        // only safe because gate subscribers signal rather than perform I/O — a subscriber
                        // that did broker work inside the notification would deadlock here.
                        await _gate.TripAsync().ConfigureAwait(false);
                        // Result discarded: same reasoning as the gate-closed branch above — nothing
                        // downstream distinguishes a landed nack from a lost one on this path.
                        _ = await SafeNackAsync(ea, requeue: true, epoch).ConfigureAwait(false);
                        Record("requeued", "store_unreachable");
                        break;
                    }

                    case DeliveryDisposition.Requeue:
                    {
                        // The projection store said nothing about itself, so the gate stays open and this
                        // consumer keeps working. Only this delivery goes back.
                        _logger.LogWarning(
                            ex, "send failed while handling {Type} — returning message to {Queue}",
                            type, _options.Queue);
                        // Result discarded: same reasoning as the gate-closed branch above — nothing
                        // downstream distinguishes a landed nack from a lost one on this path.
                        _ = await SafeNackAsync(ea, requeue: true, epoch).ConfigureAwait(false);
                        Record("requeued", "send_failed");
                        break;
                    }

                    default:
                    {
                        // Taken as a property of the message rather than of the environment. A parked
                        // message can be recovered by hand; a message requeued forever is an outage that
                        // never resolves, so the ambiguous case is deliberately resolved toward parking.
                        //
                        // LOGGED AFTER THE NACK RATHER THAN BEFORE IT, AND THAT ORDER IS THE POINT.
                        // A rejection is a park only if the broker was actually told, and
                        // SafeNackAsync returns false when the channel died in between -- in which
                        // case the broker REQUEUES the delivery instead of dead-lettering it.
                        // Logged first, the line asserted a park that had not happened, and the only
                        // correction went to Debug, which is below the level shipped to the log
                        // store. "Parked" and "quietly redelivered" then read identically forever
                        // after, which is the one thing a park record exists to distinguish.
                        //
                        // The queue name rides along for the reason the two requeue branches above
                        // already carry it: an orchestrator replica consumes three gated queues, and
                        // a park line naming only the message type cannot say which of them refused
                        // it. Attributing eleven parked outcomes to their queue took reading x-death
                        // headers off the bodies because this line did not say.
                        var landed = await SafeNackAsync(ea, requeue: false, epoch).ConfigureAwait(false);

                        // The ids, lifted off the delivery's own headers rather than the body.
                        // The handler opened a scope over these too, but it opened it INSIDE
                        // HandleAsync, so the exception that got us here disposed it on the way
                        // out -- which is why a park record carried no ids at all until the
                        // sender began stamping them. Keyed to the same fields the handler's
                        // scope uses, so a parked message is queryable beside the run it belongs
                        // to. See MessageIdHeaders.
                        using var ids = _logger.BeginScope(MessageIdHeaders.ReadScope(headers));

                        if (landed)
                        {
                            _logger.LogError(
                                ex, "refusing message of type {Type} on {Queue} — parked",
                                type, _options.Queue);
                        }
                        else
                        {
                            // Not a park. Said in full rather than as a flag, because the operator
                            // reading this is deciding whether to go looking in the dead-letter
                            // queue, and there will be nothing there.
                            _logger.LogError(
                                ex,
                                "refusing message of type {Type} on {Queue} — NOT parked: the channel "
                                + "was gone before the broker was told, so it will be redelivered "
                                + "rather than dead-lettered",
                                type, _options.Queue);
                        }

                        Record("parked", "refused");

                        // The depth gauge's cadence is five minutes; this is what makes the
                        // number reflect this park now rather than at the next backstop pass.
                        // Raised even when the nack did not land -- in that case the broker
                        // redelivers rather than dead-letters, and a read that finds nothing
                        // new costs one round trip.
                        DeadLetterReadSignal.Request();
                        break;
                    }
                }

                return;
            }

            // The handler ran and returned without throwing. This sits outside the try/catch above on
            // purpose: if SafeAckAsync or Record itself throws here, it must reach the outer catch
            // rather than be reclassified by DeliveryClassifier as a handler failure — the message was
            // already handled, and re-nacking an already-acked delivery would be its own bug.
            // Result discarded: no downstream branch distinguishes a landed ack from a lost one.
            _ = await SafeAckAsync(ea, epoch).ConfigureAwait(false);
            Record("acked", "handled");
        }
        catch (Exception)
        {
            if (!recorded)
            {
                IngressMetrics.RecordConsumed(
                    _options.Queue, type, "requeued", "escaped");
            }

            throw;
        }
        finally
        {
            // Covers every exit, including a delivery bounced off a shut gate before the handler
            // region above is ever entered. It still cost this consumer time, and a pause that is
            // slow to reject is a real thing to be able to see.
            IngressMetrics.RecordConsumerDuration(
                _options.Queue, type, disposition,
                Stopwatch.GetElapsedTime(started).TotalSeconds);
        }
    }

    /// <summary>
    /// Whether an acknowledgement for a delivery received in <paramref name="epoch"/> still means
    /// anything.
    /// </summary>
    private bool TagStillValid(long epoch) =>
        _channelUsable && _channel is { IsOpen: true } && Interlocked.Read(ref _epoch) == epoch;

    /// <summary>
    /// Acknowledges a delivery. Returns whether the broker was actually told — false means the
    /// delivery tag was void or the channel had gone, so the broker will redeliver a message whose
    /// handler already ran.
    /// </summary>
    private async Task<bool> SafeAckAsync(BasicDeliverEventArgs ea, long epoch)
    {
        if (!TagStillValid(epoch) || _channel is null)
        {
            return false;
        }

        try
        {
            await _channel.BasicAckAsync(ea.DeliveryTag, multiple: false).ConfigureAwait(false);
            return true;
        }
        catch (Exception ex) when (ex is AlreadyClosedException
                                      or OperationInterruptedException
                                      or ObjectDisposedException)
        {
            // The channel went away between the check and the call. The delivery is unacknowledged,
            // so the broker requeues it — which against an idempotent handler is a repeat, not a loss.
            _logger.LogDebug(ex, "acknowledgement dropped — channel gone");
            return false;
        }
    }

    /// <summary>
    /// Rejects a delivery. Returns whether the broker was actually told; see
    /// <see cref="SafeAckAsync"/>.
    /// </summary>
    private async Task<bool> SafeNackAsync(BasicDeliverEventArgs ea, bool requeue, long epoch)
    {
        if (!TagStillValid(epoch) || _channel is null)
        {
            // A tag from a previous epoch is meaningless now, and rejecting it would be a
            // channel-level error that closes the channel permanently. Everything unacknowledged has
            // already been requeued by the broker.
            return false;
        }

        try
        {
            await _channel.BasicNackAsync(ea.DeliveryTag, multiple: false, requeue: requeue)
                .ConfigureAwait(false);
            return true;
        }
        catch (Exception ex) when (ex is AlreadyClosedException
                                      or OperationInterruptedException
                                      or ObjectDisposedException)
        {
            _logger.LogDebug(ex, "rejection dropped — channel gone");
            return false;
        }
    }

    private Task OnChannelShutdownAsync(object sender, ShutdownEventArgs args)
    {
        // A channel-level error closes the channel for good. Without noticing it here the service
        // would sit consuming nothing while every other signal stayed green.
        _channelUsable = false;
        _consumerTag = null;
        Interlocked.Increment(ref _epoch);
        _logger.LogWarning("channel shut down: {Reason} — will reopen", args.ReplyText);

        // Wake the loop so the channel is rebuilt now rather than at the next interval.
        try
        {
            _wake.Release();
        }
        catch (SemaphoreFullException)
        {
        }

        return Task.CompletedTask;
    }

    private Task OnRecoveredAsync(object sender, AsyncEventArgs args)
    {
        // Automatic recovery renumbers deliveries: every tag captured before now is invalid.
        Interlocked.Increment(ref _epoch);
        _logger.LogInformation("connection recovered — delivery tags invalidated");
        return Task.CompletedTask;
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await base.StopAsync(cancellationToken).ConfigureAwait(false);

        await DiscardChannelAsync().ConfigureAwait(false);

        if (_subscribedConnection is not null)
        {
            _subscribedConnection.RecoverySucceededAsync -= OnRecoveredAsync;
            _subscribedConnection = null;
        }

        _wake.Dispose();
    }

    /// <summary>
    /// Detaches and disposes the current channel. Never throws — it runs during teardown and on the
    /// path that rebuilds a broken channel, where a secondary fault helps nobody.
    /// </summary>
    private async ValueTask DiscardChannelAsync()
    {
        var channel = _channel;
        var consumer = _consumer;

        _channelUsable = false;
        _consumerTag = null;
        _channel = null;
        _consumer = null;

        if (consumer is not null)
        {
            consumer.ReceivedAsync -= OnReceivedAsync;
        }

        if (channel is null)
        {
            return;
        }

        channel.ChannelShutdownAsync -= OnChannelShutdownAsync;

        try
        {
            await channel.DisposeAsync().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "consumer channel dispose failed");
        }
    }
}
