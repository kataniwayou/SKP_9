using System.Text.Json;
using Messaging.Contracts;
using Microsoft.Extensions.Logging;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;

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
/// <b>Correlating the return to the publish leans on the same serialisation that makes one shared
/// channel safe.</b> <c>_gate</c> admits one publish at a time, so at most one
/// <see cref="TaskCompletionSource{TResult}"/> is ever pending, and the broker delivers a
/// <c>basic.return</c> for an unroutable message before it delivers the confirm that
/// <c>BasicPublishAsync</c> is awaiting — so by the time the publish call completes, a return for it,
/// if any, has already been recorded. No per-message identifier is needed because there is never more
/// than one message in flight to be confused with.
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

    // Set for the duration of exactly one publish, under _gate. The return handler is channel-level,
    // not publish-level, so this field is what ties a basic.return back to the publish that caused it.
    private TaskCompletionSource<bool>? _pendingReturn;

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

        var properties = QueueSender.BuildProperties(type, replyTo: null, correlationId: null);

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var channel = await GetChannelAsync(ct).ConfigureAwait(false);

            var returned = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            _pendingReturn = returned;

            // A named exchange instead of the default one, an empty routing key because a fan-out
            // exchange ignores it, and mandatory: true so a discarded message comes back as a return
            // instead of vanishing behind a confirm that only means "accepted".
            await channel.BasicPublishAsync(
                exchange: exchange,
                routingKey: string.Empty,
                mandatory: true,
                basicProperties: properties,
                body: payload,
                cancellationToken: ct).ConfigureAwait(false);

            if (returned.Task.IsCompletedSuccessfully)
            {
                throw new UnroutablePublishException(exchange);
            }
        }
        catch (Exception ex)
        {
            // A channel that faulted — or that just reported an unroutable publish — is not trusted
            // for the next publish, so it is dropped here rather than reused. Recreation happens on
            // the next publish, under this same lock.
            await DiscardChannelAsync().ConfigureAwait(false);
            _logger.LogWarning(ex, "publish to {Exchange} failed; publish channel discarded", exchange);

            if (SendFaultClassifier.IsTransport(ex))
            {
                throw new TransientSendException($"publish to {exchange} failed", ex);
            }

            throw;
        }
        finally
        {
            _pendingReturn = null;
            _gate.Release();
        }
    }

    /// <summary>
    /// Records that the in-flight publish came back unrouted. Runs on the connection's dispatch
    /// thread, never concurrently with the publish it belongs to — <see cref="_gate"/> already
    /// guarantees there is at most one.
    /// </summary>
    private Task OnBasicReturnAsync(object sender, BasicReturnEventArgs args)
    {
        _pendingReturn?.TrySetResult(true);
        return Task.CompletedTask;
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

        var options = new CreateChannelOptions(
            publisherConfirmationsEnabled: true,
            publisherConfirmationTrackingEnabled: true);

        var channel = await connection.CreateChannelAsync(options, ct).ConfigureAwait(false);
        channel.BasicReturnAsync += OnBasicReturnAsync;

        _channel = channel;
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
            channel.BasicReturnAsync -= OnBasicReturnAsync;
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
