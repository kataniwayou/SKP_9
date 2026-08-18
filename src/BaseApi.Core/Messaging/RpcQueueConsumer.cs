using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;
using RabbitMQ.Client.Exceptions;

namespace BaseApi.Core.Messaging;

/// <summary>
/// Serves request-reply queries on one queue: reads a request, resolves a handler by its type header,
/// and publishes the answer back to the address the caller nominated.
/// <para>
/// <b>The reply address comes from the request, not from configuration.</b> A caller sets a reply-to
/// address and a correlation id on the request; this consumer publishes the answer to that address
/// with the same correlation id echoed, which is how the caller matches an answer to the question it
/// asked. That correlation id is transport machinery for pairing a reply with a request — it is not,
/// and must not become, an application trace identifier.
/// </para>
/// <para>
/// <b>A request with no reply address is dropped rather than parked.</b> There is nobody to answer,
/// so there is no failure to report and nothing a retry could achieve; parking it would fill the
/// dead-letter queue with requests whose sender has already given up.
/// </para>
/// <para>
/// <b>These queries are not gated.</b> They are answered from the database, so an outage of the
/// projection store is irrelevant to them, and pausing them would spread one dependency's failure to
/// callers that were not depending on it.
/// </para>
/// </summary>
public sealed class RpcQueueConsumer : BackgroundService
{
    private readonly string _queue;
    private readonly RabbitMqConnection _connection;
    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<RpcQueueConsumer> _logger;

    private IChannel? _channel;

    // How long to wait before rebuilding after the broker proves unreachable. Long enough not to spin
    // against a broker that is down, short enough that recovery is not noticeably delayed.
    private static readonly TimeSpan RetryDelay = TimeSpan.FromSeconds(5);

    public RpcQueueConsumer(
        string queue,
        RabbitMqConnection connection,
        IServiceScopeFactory scopes,
        ILogger<RpcQueueConsumer> logger)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(queue);
        _queue      = queue;
        _connection = connection ?? throw new ArgumentNullException(nameof(connection));
        _scopes     = scopes ?? throw new ArgumentNullException(nameof(scopes));
        _logger     = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (_channel is not { IsOpen: true })
                {
                    await OpenAsync(stoppingToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // The broker is unreachable. Keep the loop alive and try again — ending it here would
                // leave the queue unserved for the life of the process, long after the broker returned.
                _logger.LogWarning(ex, "query consumer could not attach to {Queue}", _queue);
            }

            try
            {
                await Task.Delay(RetryDelay, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private async Task OpenAsync(CancellationToken ct)
    {
        await DiscardChannelAsync().ConfigureAwait(false);

        var connection = await _connection.GetAsync(ct).ConfigureAwait(false);
        var channel = await connection.CreateChannelAsync(cancellationToken: ct).ConfigureAwait(false);

        var consumer = new AsyncEventingBasicConsumer(channel);
        consumer.ReceivedAsync += OnReceivedAsync;

        _channel = channel;
        await channel.BasicConsumeAsync(_queue, autoAck: false, consumer, ct).ConfigureAwait(false);
        _logger.LogInformation("serving queries on {Queue}", _queue);
    }

    private async Task OnReceivedAsync(object sender, BasicDeliverEventArgs ea)
    {
        var channel = _channel;
        if (channel is not { IsOpen: true })
        {
            return;   // the channel went away; the delivery is unacknowledged and will be redelivered
        }

        var replyTo = ea.BasicProperties.ReplyTo;
        var correlationId = ea.BasicProperties.CorrelationId;
        var requestType = ea.BasicProperties.Type;
        var body = ea.Body.ToArray();

        try
        {
            if (string.IsNullOrWhiteSpace(replyTo))
            {
                _logger.LogWarning("query on {Queue} carried no reply address — dropping", _queue);
                return;
            }

            if (string.IsNullOrWhiteSpace(requestType))
            {
                _logger.LogWarning("query on {Queue} carried no type header — dropping", _queue);
                return;
            }

            await using var scope = _scopes.CreateAsyncScope();
            var handler = scope.ServiceProvider
                .GetServices<IRpcHandler>()
                .SingleOrDefault(h => h.RequestType == requestType);

            if (handler is null)
            {
                _logger.LogWarning(
                    "no handler for query type {Type} on {Queue} — dropping", requestType, _queue);
                return;
            }

            var reply = await handler.HandleAsync(body, CancellationToken.None).ConfigureAwait(false);

            var properties = new BasicProperties
            {
                ContentType   = "application/json",
                Type          = reply.Type,
                // Echoed, never re-minted: this is the only thing that lets the caller pair this
                // answer with the question it asked.
                CorrelationId = correlationId,
            };

            // Default exchange with the caller's reply address as the routing key. Not mandatory: a
            // caller that has already gone away is an expected outcome, not a fault to raise.
            await channel.BasicPublishAsync(
                exchange: string.Empty,
                routingKey: replyTo,
                mandatory: false,
                basicProperties: properties,
                body: reply.Body).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // The caller is waiting and will time out; there is nothing useful to send them, and no
            // reason to keep the request. Log it here, where the detail is available.
            _logger.LogError(ex, "query of type {Type} on {Queue} failed", requestType, _queue);
        }
        finally
        {
            await SafeAckAsync(channel, ea.DeliveryTag).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Acknowledges the request whatever happened to it. A query holds no state and cannot be repaired
    /// by redelivery — the caller has already moved on or timed out — so leaving it unacknowledged
    /// would only have it redelivered to answer a caller who is no longer listening.
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
            _logger.LogDebug(ex, "query acknowledgement dropped — channel gone");
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await base.StopAsync(cancellationToken).ConfigureAwait(false);
        await DiscardChannelAsync().ConfigureAwait(false);
    }

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
            _logger.LogDebug(ex, "query channel dispose failed");
        }
    }
}
