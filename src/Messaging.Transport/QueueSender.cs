using System.Text.Json;
using Messaging.Contracts;
using Microsoft.Extensions.Logging;
using RabbitMQ.Client;

namespace Messaging.Transport;

/// <summary>
/// The send primitive: one channel, one message at a time, confirmed by the broker before the call
/// returns.
/// <para>
/// <b>Publisher confirmations plus <c>mandatory</c> are what make the return value meaningful.</b>
/// Without confirmations the call completes as soon as the frame is written, so a broker that dies
/// mid-flight loses the message while the caller has already been told it was accepted. Without
/// <c>mandatory</c> a message addressed to a queue that does not exist is discarded by the broker —
/// and still confirmed, because discarding it <i>is</i> the broker accepting responsibility. With
/// both enabled the client correlates the return to the publish and faults it, so an unroutable send
/// raises rather than silently succeeding.
/// </para>
/// <para>
/// <b>One channel behind one semaphore, deliberately.</b> A channel is not safe for concurrent use,
/// and these are control-plane messages at human frequency, so serialising them costs nothing worth
/// measuring. It also pairs with the consumer, which takes one message at a time: neither side is
/// the place to look for throughput. A high-volume path must not be added to this sender — it would
/// queue behind every control message — and should take its own channel.
/// </para>
/// </summary>
public sealed class QueueSender : IQueueSender, IAsyncDisposable
{
    private readonly RabbitMqConnection _connection;
    private readonly ILogger<QueueSender> _logger;

    // Serialises publishes AND guards channel creation/replacement. One lock rather than two: a
    // second lock around the channel field would have to be taken inside this one on every send,
    // and could only ever be uncontended.
    private readonly SemaphoreSlim _gate = new(1, 1);
    private IChannel? _channel;

    public QueueSender(RabbitMqConnection connection, ILogger<QueueSender> logger)
    {
        _connection = connection ?? throw new ArgumentNullException(nameof(connection));
        _logger     = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async Task SendAsync<T>(string queue, string type, T body, CancellationToken ct, string? replyTo = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(queue);
        ArgumentException.ThrowIfNullOrWhiteSpace(type);

        var payload = JsonSerializer.SerializeToUtf8Bytes(body, MessagingJson.Options);

        var properties = new BasicProperties
        {
            // Persistent alone does not survive a broker restart — the queue must be durable too.
            // Both halves are required, and each is declared where it belongs: the flag here, the
            // queue's durability in its topology declaration.
            DeliveryMode = DeliveryModes.Persistent,
            ContentType  = "application/json",
            Type         = type,
        };

        if (replyTo is not null)
        {
            properties.ReplyTo = replyTo;
        }

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var channel = await GetChannelAsync(ct).ConfigureAwait(false);

            // Empty exchange = the default exchange, which routes to the queue named by the routing
            // key. mandatory: true turns "no such queue" into a fault instead of a silent discard.
            await channel.BasicPublishAsync(
                exchange: string.Empty,
                routingKey: queue,
                mandatory: true,
                basicProperties: properties,
                body: payload,
                cancellationToken: ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // A channel that faulted is unusable for every later send, so drop it here rather than
            // letting the next caller discover it. Recreation happens on the next send, under this
            // same lock. The original exception is what the caller needs, so it propagates untouched.
            await DiscardChannelAsync().ConfigureAwait(false);
            _logger.LogWarning(ex, "send to {Queue} failed; send channel discarded", queue);
            throw;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Returns the send channel, creating it on first use and after a fault. Callers hold
    /// <c>_gate</c>.
    /// </summary>
    private async Task<IChannel> GetChannelAsync(CancellationToken ct)
    {
        if (_channel is { IsOpen: true })
        {
            return _channel;
        }

        if (_channel is not null)
        {
            await DiscardChannelAsync().ConfigureAwait(false);
        }

        var connection = await _connection.GetAsync(ct).ConfigureAwait(false);

        // Tracking is what lets the client match a confirmation — or a return — back to the publish
        // that produced it. Enabling confirmations without tracking would confirm nothing in
        // particular, and BasicPublishAsync would go back to completing on the write.
        var options = new CreateChannelOptions(
            publisherConfirmationsEnabled: true,
            publisherConfirmationTrackingEnabled: true);

        _channel = await connection.CreateChannelAsync(options, ct).ConfigureAwait(false);
        return _channel;
    }

    /// <summary>
    /// Disposes the current channel and forgets it. Never throws: it runs on the failure path, where
    /// a secondary fault would replace the diagnosis the caller is about to receive.
    /// </summary>
    private async ValueTask DiscardChannelAsync()
    {
        var channel = _channel;
        _channel = null;

        if (channel is null)
        {
            return;
        }

        try
        {
            await channel.DisposeAsync().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "send channel dispose failed");
        }
    }

    public async ValueTask DisposeAsync()
    {
        await DiscardChannelAsync().ConfigureAwait(false);
        _gate.Dispose();
    }
}
