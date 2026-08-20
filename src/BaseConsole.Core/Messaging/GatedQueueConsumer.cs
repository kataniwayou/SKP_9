using BaseConsole.Core.Gating;
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
/// </summary>
public sealed class GatedQueueConsumer : BackgroundService
{
    private readonly RabbitMqConnection _connection;
    private readonly L2Gate _gate;
    private readonly IServiceScopeFactory _scopes;
    private readonly GatedConsumerOptions _options;
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
        ILogger<GatedQueueConsumer> logger)
    {
        _connection = connection ?? throw new ArgumentNullException(nameof(connection));
        _gate       = gate ?? throw new ArgumentNullException(nameof(gate));
        _scopes     = scopes ?? throw new ArgumentNullException(nameof(scopes));
        _options    = options?.Value ?? throw new ArgumentNullException(nameof(options));
        _logger     = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>Whether the consumer currently holds a subscription to the queue.</summary>
    public bool IsConsuming => _consumerTag is not null;

    /// <summary>Whether the channel is in a state where consuming is possible at all.</summary>
    public bool IsChannelUsable => _channelUsable;

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
                    _logger.LogWarning(ex, "consumer could not reach the state the gate calls for");
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

        var shouldConsume = _gate.IsOpen;

        if (shouldConsume && _consumerTag is null)
        {
            _consumerTag = await _channel
                .BasicConsumeAsync(_options.Queue, autoAck: false, _consumer, ct)
                .ConfigureAwait(false);
            _logger.LogInformation("projection store healthy — consuming {Queue}", _options.Queue);
        }
        else if (!shouldConsume && _consumerTag is not null)
        {
            var tag = _consumerTag;
            _consumerTag = null;

            // noWait: the confirmation would be delivered through the same dispatcher a handler may
            // currently occupy, and waiting for it there is a deadlock at a dispatch concurrency of
            // one. Nothing depends on the confirmation — the next pass re-checks.
            await _channel.BasicCancelAsync(tag, noWait: true, ct).ConfigureAwait(false);
            _logger.LogWarning("projection store unavailable — paused consuming {Queue}", _options.Queue);
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

    private async Task OnReceivedAsync(object sender, BasicDeliverEventArgs ea)
    {
        var epoch = Interlocked.Read(ref _epoch);

        // The gate can close between the broker handing this message over and it arriving here, and
        // messages already in flight when the subscription was cancelled still arrive. Re-checking
        // here is what makes a pause clean rather than a burst of failures.
        if (!_gate.IsOpen)
        {
            await SafeNackAsync(ea, requeue: true, epoch).ConfigureAwait(false);
            return;
        }

        // Copy out of the transport buffer, which is pooled and valid only for this callback.
        var body = ea.Body.ToArray();
        var type = ea.BasicProperties.Type;

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

            await SafeAckAsync(ea, epoch).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            switch (DeliveryClassifier.Classify(ex))
            {
                case DeliveryDisposition.RequeueAndTrip:
                    _logger.LogWarning(
                        ex, "projection store unreachable — returning message to {Queue}", _options.Queue);

                    // Awaited rather than fired and forgotten: closing the gate before the message goes
                    // back means the redelivery finds it already closed instead of racing it. That is
                    // only safe because gate subscribers signal rather than perform I/O — a subscriber
                    // that did broker work inside the notification would deadlock here.
                    await _gate.TripAsync().ConfigureAwait(false);
                    await SafeNackAsync(ea, requeue: true, epoch).ConfigureAwait(false);
                    break;

                case DeliveryDisposition.Requeue:
                    // The projection store said nothing about itself, so the gate stays open and this
                    // consumer keeps working. Only this delivery goes back.
                    _logger.LogWarning(
                        ex, "send failed while handling {Type} — returning message to {Queue}",
                        type, _options.Queue);
                    await SafeNackAsync(ea, requeue: true, epoch).ConfigureAwait(false);
                    break;

                default:
                    // Taken as a property of the message rather than of the environment. A parked
                    // message can be recovered by hand; a message requeued forever is an outage that
                    // never resolves, so the ambiguous case is deliberately resolved toward parking.
                    _logger.LogError(ex, "refusing message of type {Type} — parking", type);
                    await SafeNackAsync(ea, requeue: false, epoch).ConfigureAwait(false);
                    break;
            }
        }
    }

    /// <summary>
    /// Whether an acknowledgement for a delivery received in <paramref name="epoch"/> still means
    /// anything.
    /// </summary>
    private bool TagStillValid(long epoch) =>
        _channelUsable && _channel is { IsOpen: true } && Interlocked.Read(ref _epoch) == epoch;

    private async Task SafeAckAsync(BasicDeliverEventArgs ea, long epoch)
    {
        if (!TagStillValid(epoch) || _channel is null)
        {
            return;
        }

        try
        {
            await _channel.BasicAckAsync(ea.DeliveryTag, multiple: false).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is AlreadyClosedException
                                      or OperationInterruptedException
                                      or ObjectDisposedException)
        {
            // The channel went away between the check and the call. The delivery is unacknowledged,
            // so the broker requeues it — which against an idempotent handler is a repeat, not a loss.
            _logger.LogDebug(ex, "acknowledgement dropped — channel gone");
        }
    }

    private async Task SafeNackAsync(BasicDeliverEventArgs ea, bool requeue, long epoch)
    {
        if (!TagStillValid(epoch) || _channel is null)
        {
            // A tag from a previous epoch is meaningless now, and rejecting it would be a
            // channel-level error that closes the channel permanently. Everything unacknowledged has
            // already been requeued by the broker.
            return;
        }

        try
        {
            await _channel.BasicNackAsync(ea.DeliveryTag, multiple: false, requeue: requeue)
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is AlreadyClosedException
                                      or OperationInterruptedException
                                      or ObjectDisposedException)
        {
            _logger.LogDebug(ex, "rejection dropped — channel gone");
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
