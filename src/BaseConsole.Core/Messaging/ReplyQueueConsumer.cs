using BaseConsole.Core.Loop;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;
using RabbitMQ.Client.Exceptions;

namespace BaseConsole.Core.Messaging;

/// <summary>
/// The processor's own reply address: an exclusive, auto-delete queue that dies with the connection,
/// so nothing is orphaned in the broker when a replica goes away.
/// <para>
/// This consumer never touches processor state. It parses, hands the payload to the slot, acks, and
/// signals — leaving the loop as the sole writer.
/// </para>
/// </summary>
public sealed class ReplyQueueConsumer : IAsyncDisposable
{
    private readonly RabbitMqConnection _connection;
    private readonly ReplySlot<object> _slot;
    private readonly ILogger<ReplyQueueConsumer> _logger;
    private IChannel? _channel;

    public ReplyQueueConsumer(
        RabbitMqConnection connection,
        ReplySlot<object> slot,
        InstanceId instanceId,
        ILogger<ReplyQueueConsumer> logger)
    {
        _connection = connection ?? throw new ArgumentNullException(nameof(connection));
        _slot       = slot ?? throw new ArgumentNullException(nameof(slot));
        _logger     = logger ?? throw new ArgumentNullException(nameof(logger));
        ArgumentNullException.ThrowIfNull(instanceId);
        QueueName = $"proc-reply-{instanceId.Value}";
    }

    /// <summary>The reply address sent as <c>ReplyTo</c> on every request.</summary>
    public string QueueName { get; }

    /// <summary>
    /// Declares the queue and attaches the consumer if it is not already up, returning only once the
    /// broker has confirmed the subscription. Cheap and idempotent on the common path — the queue is
    /// exclusive and auto-delete, so it dies with its connection, and this is what re-creates it after
    /// a broker reconnect. Safe to call on every loop tick: when a live channel is already attached it
    /// returns immediately without talking to the broker.
    /// </summary>
    public async Task EnsureStartedAsync(CancellationToken ct)
    {
        if (_channel is { IsOpen: true })
        {
            return;
        }

        var previous = _channel;
        _channel = null;
        if (previous is not null)
        {
            await previous.DisposeAsync().ConfigureAwait(false);
        }

        var connection = await _connection.GetAsync(ct).ConfigureAwait(false);
        var channel = await connection.CreateChannelAsync(cancellationToken: ct).ConfigureAwait(false);

        await channel.QueueDeclareAsync(
            queue: QueueName,
            durable: false,
            exclusive: true,
            autoDelete: true,
            arguments: null,
            cancellationToken: ct).ConfigureAwait(false);

        var consumer = new AsyncEventingBasicConsumer(channel);
        consumer.ReceivedAsync += OnReceivedAsync;

        await channel.BasicConsumeAsync(
            QueueName, autoAck: false, consumer, ct).ConfigureAwait(false);

        _channel = channel;
        _logger.LogInformation("reply queue {Queue} bound", QueueName);
    }

    private async Task OnReceivedAsync(object sender, BasicDeliverEventArgs ea)
    {
        // The channel this specific delivery arrived on, not the field: a rebind (EnsureStartedAsync
        // replacing a dead channel) can race with an in-flight delivery, and the ack must go back on
        // the channel that issued the delivery tag, not on whatever channel is current when this
        // handler finally runs.
        var channel = ((IAsyncBasicConsumer)sender).Channel;
        var type = ea.BasicProperties.Type ?? string.Empty;
        try
        {
            var routed = DiscoveryReplyRouter.Route(type, ea.Body);
            if (routed is null)
            {
                _logger.LogWarning("reply of unknown type {Type} on {Queue} — dropping", type, QueueName);
            }
            else
            {
                _slot.Publish(routed);
            }
        }
        catch (Exception ex)
        {
            // A property of the message, not of the environment. The loop asks again on its next
            // tick, so there is nothing worth parking and nobody left to answer from a dead letter.
            _logger.LogError(ex, "reply of type {Type} on {Queue} could not be read — dropping", type, QueueName);
        }
        finally
        {
            if (channel is not null)
            {
                await SafeAckAsync(channel, ea.DeliveryTag).ConfigureAwait(false);
            }
        }
    }

    /// <summary>
    /// Acknowledges the delivery whatever happened to it. A reply holds no state and cannot be
    /// repaired by redelivery — the next tick asks again regardless — so leaving it unacknowledged
    /// would only have it redelivered to a listener that no longer needs it. The ack call itself is
    /// wrapped, not just gated on <c>IsOpen</c> beforehand: the channel can close between that check
    /// and the awaited call, and a closed channel here is an expected outcome to record, not an
    /// exception to leak out of an async event handler with nothing above it to catch it.
    /// </summary>
    private async Task SafeAckAsync(IChannel channel, ulong deliveryTag)
    {
        try
        {
            await channel.BasicAckAsync(deliveryTag, multiple: false).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is AlreadyClosedException
                                      or OperationInterruptedException
                                      or ObjectDisposedException)
        {
            _logger.LogDebug(ex, "reply acknowledgement dropped — channel gone");
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_channel is not null)
        {
            await _channel.DisposeAsync().ConfigureAwait(false);
        }
    }
}
