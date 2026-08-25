using System.Text.Json;
using Messaging.Contracts;
using Microsoft.Extensions.Logging;
using RabbitMQ.Client;
using RabbitMQ.Client.Exceptions;

namespace Messaging.Transport;

/// <summary>
/// The publish primitive: one channel, one message at a time, confirmed by the broker and correlated
/// to its route before the call returns.
/// <para>
/// <b>Sibling of <see cref="QueueSender"/>, not a variant of it.</b> Same connection, same serializer
/// options, same delivery mode, same confirm settings, same one-channel-behind-one-semaphore shape —
/// the difference is entirely in what a publish is addressed to and what a healthy outcome means. A
/// send is addressed to a queue and a broker acceptance is the whole story; a publish is addressed to
/// an exchange, and acceptance alone is not enough, because an exchange with nothing bound to it
/// accepts and discards in the same breath.
/// </para>
/// <para>
/// <b>The route is confirmed by the client library, not by hand-correlating a return.</b> The channel
/// is created with <c>publisherConfirmationTrackingEnabled: true</c>, and with tracking on, a
/// <c>mandatory</c> publish that comes back as a <c>basic.return</c> makes <c>BasicPublishAsync</c>
/// itself throw <see cref="PublishException"/> with <see cref="PublishException.IsReturn"/> true,
/// instead of completing — there is no untracked return frame here for this class to correlate by
/// hand. <see cref="PublishAsync{T}"/> catches that specific shape and remaps it to
/// <see cref="UnroutablePublishException"/>, which names the exchange rather than leaving the caller
/// to interpret a library exception.
/// </para>
/// </summary>
public sealed class QueueFanoutPublisher : IQueueFanoutPublisher, IAsyncDisposable
{
    private readonly RabbitMqConnection _connection;
    private readonly ILogger<QueueFanoutPublisher> _logger;

    // Serialises publishes AND guards channel creation/replacement, for the same reason QueueSender
    // uses one lock rather than two: a second lock around the channel field would have to be taken
    // inside this one on every publish, and could only ever be uncontended.
    private readonly SemaphoreSlim _gate = new(1, 1);
    private IChannel? _channel;

    public QueueFanoutPublisher(RabbitMqConnection connection, ILogger<QueueFanoutPublisher> logger)
    {
        _connection = connection ?? throw new ArgumentNullException(nameof(connection));
        _logger     = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async Task PublishAsync<T>(string exchange, string type, T body, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(exchange);
        ArgumentException.ThrowIfNullOrWhiteSpace(type);

        var payload = JsonSerializer.SerializeToUtf8Bytes(body, MessagingJson.Options);

        var properties = QueueSender.BuildProperties(type, replyTo: null, correlationId: null, body);

        try
        {
            // Measured inside the outer try so the metric sees the RAW fault, before the remap to
            // UnroutablePublishException and the wrap into TransientSendException below.
            // EgressMetrics.Classify is written against those raw shapes.
            await EgressMetrics.MeasureAsync(EgressMetrics.RouteFanout, exchange, type, async () =>
            {
                // The gate wait is inside this classified region, not before it: a caller that
                // arrives already cancelled must still see TransientSendException, not a raw
                // OperationCanceledException, or DeliveryClassifier would park the control message
                // instead of requeuing it.
                await _gate.WaitAsync(ct).ConfigureAwait(false);
                try
                {
                    var channel = await GetChannelAsync(ct).ConfigureAwait(false);

                    // A named exchange instead of the default one, an empty routing key because a
                    // fan-out exchange ignores it, and mandatory: true so an unroutable message is
                    // reported rather than silently discarded and confirmed anyway.
                    await channel.BasicPublishAsync(
                        exchange: exchange,
                        routingKey: string.Empty,
                        mandatory: true,
                        basicProperties: properties,
                        body: payload,
                        cancellationToken: ct).ConfigureAwait(false);
                }
                finally
                {
                    _gate.Release();
                }
            }).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // A channel that faulted is not trusted for the next publish, so it is dropped here
            // rather than reused. Recreation happens on the next publish, under this same lock. Safe
            // to call even when the fault happened before any channel was touched, e.g. a cancelled
            // gate wait.
            await DiscardChannelAsync().ConfigureAwait(false);
            _logger.LogWarning(ex, "publish to {Exchange} failed; publish channel discarded", exchange);

            // The client library's own correlation of a return to the publish that caused it.
            // Recognised by its type, not this task's own type, so it is remapped to the
            // exchange-naming diagnosis before the generic classification below runs.
            if (ex is PublishException { IsReturn: true })
            {
                ex = new UnroutablePublishException(exchange);
            }

            if (SendFaultClassifier.IsTransport(ex))
            {
                throw new TransientSendException($"publish to {exchange} failed", ex);
            }

            throw;
        }
    }

    /// <summary>
    /// Returns the publish channel, creating it on first use and after a fault. Callers hold
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

        // Tracking is what makes a return arrive as a thrown PublishException on this same call
        // rather than as an untracked event with nothing to correlate it to.
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
            _logger.LogDebug(ex, "publish channel dispose failed");
        }
    }

    public async ValueTask DisposeAsync()
    {
        await DiscardChannelAsync().ConfigureAwait(false);
        _gate.Dispose();
    }
}
