using BaseConsole.Core.Loop;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;

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
    /// Declares the queue and attaches the consumer, returning only once the broker has confirmed
    /// the subscription. Asking before this completes would let an answer arrive with no listener.
    /// </summary>
    public async Task StartAsync(CancellationToken ct)
    {
        var connection = await _connection.GetAsync(ct).ConfigureAwait(false);
        _channel = await connection.CreateChannelAsync(cancellationToken: ct).ConfigureAwait(false);

        await _channel.QueueDeclareAsync(
            queue: QueueName,
            durable: false,
            exclusive: true,
            autoDelete: true,
            arguments: null,
            cancellationToken: ct).ConfigureAwait(false);

        var consumer = new AsyncEventingBasicConsumer(_channel);
        consumer.ReceivedAsync += OnReceivedAsync;

        await _channel.BasicConsumeAsync(
            QueueName, autoAck: false, consumer, ct).ConfigureAwait(false);

        _logger.LogInformation("reply queue {Queue} bound", QueueName);
    }

    private async Task OnReceivedAsync(object sender, BasicDeliverEventArgs ea)
    {
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
            if (_channel is { IsOpen: true })
            {
                await _channel.BasicAckAsync(ea.DeliveryTag, multiple: false).ConfigureAwait(false);
            }
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
