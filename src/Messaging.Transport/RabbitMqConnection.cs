using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using RabbitMQ.Client;

namespace Messaging.Transport;

/// <summary>
/// The process-wide broker connection, opened once on first use and shared by every send and every
/// consumer.
/// <para>
/// <b>Topology declaration is part of opening the connection, not a step someone must remember to
/// sequence first.</b> The first caller to ask for a connection runs the declaration; every later
/// caller — sender or consumer — awaits the same completed initialisation. That makes "the topology
/// exists" a property of holding a connection rather than an ordering convention between hosted
/// services, and ordering conventions are exactly what a later refactor breaks silently.
/// </para>
/// <para>
/// <b>Connecting lazily rather than at construction is deliberate.</b> A dependency-injection factory
/// cannot await, so an eager connection would have to block a container-resolution thread, and a
/// broker that is slow to accept connections would then stall startup — or crash it, taking down the
/// health endpoint that exists to report the problem. Lazily opening on first use lets the process
/// start, serve <c>/health/live</c>, and report the broker as degraded.
/// </para>
/// <para>
/// <b><see cref="ConnectionFactory.ConsumerDispatchConcurrency"/> is pinned to 1 and must stay there
/// unless every consumer is known to be thread-safe.</b> It is also what makes the pause path safe:
/// a consumer that awaited its own cancellation would wait for a confirmation delivered by the very
/// dispatcher its handler is occupying.
/// </para>
/// </summary>
public sealed class RabbitMqConnection : IAsyncDisposable
{
    private readonly RabbitMqOptions _options;
    private readonly IEnumerable<IRabbitMqTopology> _topologies;
    private readonly ILogger<RabbitMqConnection> _logger;

    // Guards initialisation only. Once _connection is non-null every caller takes the fast path and
    // never touches the semaphore again.
    private readonly SemaphoreSlim _init = new(1, 1);
    private IConnection? _connection;

    public RabbitMqConnection(
        IOptions<RabbitMqOptions> options,
        IEnumerable<IRabbitMqTopology> topologies,
        ILogger<RabbitMqConnection> logger)
    {
        _options    = options?.Value ?? throw new ArgumentNullException(nameof(options));
        _topologies = topologies ?? throw new ArgumentNullException(nameof(topologies));
        _logger     = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>
    /// True when a connection has been opened and is currently usable. False both before the first
    /// use and while the connection is down — the health check reports the two identically on
    /// purpose, since neither state can serve a send.
    /// </summary>
    public bool IsOpen => _connection is { IsOpen: true };

    /// <summary>
    /// The shared connection, opening it and declaring topology on first call.
    /// </summary>
    public async ValueTask<IConnection> GetAsync(CancellationToken ct)
    {
        var existing = _connection;
        if (existing is { IsOpen: true })
        {
            return existing;
        }

        await _init.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            // Re-check under the lock: several callers can race past the fast path, and only the
            // first should open a connection.
            if (_connection is { IsOpen: true })
            {
                return _connection;
            }

            // A connection that exists but is closed is not recoverable by us — automatic recovery
            // owns that. Reaching here with a closed connection means recovery has not yet
            // succeeded, so a fresh connect is the honest response.
            if (_connection is not null)
            {
                await SafeDisposeAsync(_connection).ConfigureAwait(false);
                _connection = null;
            }

            var factory = new ConnectionFactory
            {
                HostName                    = _options.Host,
                Port                        = _options.Port,
                VirtualHost                 = _options.VirtualHost,
                UserName                    = _options.Username,
                Password                    = _options.Password,
                RequestedHeartbeat          = _options.Heartbeat,
                AutomaticRecoveryEnabled    = true,
                TopologyRecoveryEnabled     = true,
                ConsumerDispatchConcurrency = 1,
            };

            var connection = await factory.CreateConnectionAsync(ct).ConfigureAwait(false);
            await DeclareTopologyAsync(connection, ct).ConfigureAwait(false);

            _connection = connection;
            _logger.LogInformation("broker connection open; topology declared");
            return connection;
        }
        finally
        {
            _init.Release();
        }
    }

    /// <summary>
    /// Runs every registered topology unit on one short-lived setup channel.
    /// <para>
    /// A declaration failure propagates and leaves <c>_connection</c> unset, so the connection is not
    /// published to callers half-configured — the next caller retries the whole sequence. Publishing
    /// a connection whose topology failed would hand out exactly the state that makes a send
    /// unroutable.
    /// </para>
    /// </summary>
    private async Task DeclareTopologyAsync(IConnection connection, CancellationToken ct)
    {
        await using var channel = await connection
            .CreateChannelAsync(cancellationToken: ct)
            .ConfigureAwait(false);

        foreach (var topology in _topologies)
        {
            await topology.DeclareAsync(channel, ct).ConfigureAwait(false);
        }
    }

    public async ValueTask DisposeAsync()
    {
        var connection = _connection;
        _connection = null;

        if (connection is not null)
        {
            await SafeDisposeAsync(connection).ConfigureAwait(false);
        }

        _init.Dispose();
    }

    /// <summary>
    /// Closes and disposes without letting a shutdown-time fault escape. Nothing useful can be done
    /// about a connection that fails to close cleanly, and throwing here would mask whatever was
    /// actually being torn down.
    /// </summary>
    private async ValueTask SafeDisposeAsync(IConnection connection)
    {
        try
        {
            if (connection.IsOpen)
            {
                await connection.CloseAsync().ConfigureAwait(false);
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "broker connection close failed during teardown");
        }

        try
        {
            await connection.DisposeAsync().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "broker connection dispose failed during teardown");
        }
    }
}
