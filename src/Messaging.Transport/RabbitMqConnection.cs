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
/// <para>
/// <b>The queue-stats probes get their OWN connection, and that is a consequence of the line above.</b>
/// Dispatch concurrency of 1 means one dispatcher per connection serves every consumer on it, so
/// anything else that occupies that connection's dispatcher delays deliveries. <see cref="QueueStatsProbe"/>
/// opens and closes a channel per queue per pass, which is exactly such an occupant. The separation
/// is justified by that coupling alone: a measurement path should not be able to slow the path it
/// measures, whatever the size of the effect turns out to be.
/// </para>
/// <para>
/// <b>It is NOT known to fix the 210s cycle, and this comment exists partly to stop that being
/// assumed.</b> There is a real, twice-confirmed periodicity on this stack -- one workload burst in
/// seven runs slow, on a 210s cycle (Prometheus: eta^2 = 0.65 against burst-index mod 7; and
/// independently in Elasticsearch end-to-end lineage duration: +79ms at the same phase,
/// permutation p = 0.0005). This probe was the leading suspect, because its <c>Task.Delay</c> comes
/// AFTER its work, so its period free-runs while the workload burst is wall-clock locked, and the
/// two would beat.
/// </para>
/// <para>
/// That was tested by disabling the probe and it did NOT convict it. The window could only resolve a
/// 155ms effect against a 79ms one, so its null proved nothing, and its point estimate was unchanged.
/// Worse for the theory: the slow phase sits at the same ABSOLUTE wall-clock position before and
/// after a pod restart, whereas a process-local free-running timer would land somewhere new. So the
/// cause is still open -- treat a future measurement, not this split, as the thing that settles it.
/// </para>
/// <para>
/// Whatever the cause, it is only visible when consumers have no slack: at eight replicas nothing
/// measurable happened. Which is the argument for making this structural rather than a tuning knob.
/// </para>
/// </summary>
public sealed class RabbitMqConnection : IAsyncDisposable
{
    /// <summary>
    /// DI key for the probe-only connection. Registered alongside the primary one by the same
    /// extension method, so a host cannot acquire one without the other.
    /// </summary>
    public const string ProbeKey = "probe";

    /// <summary>
    /// <c>ClientProvidedName</c> values, which the broker reports per connection. Without them both
    /// connections are anonymous and indistinguishable in <c>rabbitmqctl list_connections</c> --
    /// which is the exact view an operator needs when deciding whether probe traffic is interfering
    /// with delivery, the question that produced this split in the first place.
    /// </summary>
    public const string PrimaryName = "skp-primary";
    public const string ProbeName   = "skp-probe";

    private readonly RabbitMqOptions _options;
    private readonly IEnumerable<IRabbitMqTopology> _topologies;
    private readonly ILogger<RabbitMqConnection> _logger;
    private readonly string _clientName;

    // Guards initialisation only. Once _connection is non-null every caller takes the fast path and
    // never touches the semaphore again.
    private readonly SemaphoreSlim _init = new(1, 1);
    private IConnection? _connection;

    /// <param name="clientName">
    /// What the broker reports for this connection. Defaulted rather than required so the three
    /// tests that construct this type directly keep compiling; the DI registrations pass it
    /// explicitly, which is also why this type keeps exactly one constructor -- a second overload
    /// would put the container in the business of choosing between them.
    /// </param>
    public RabbitMqConnection(
        IOptions<RabbitMqOptions> options,
        IEnumerable<IRabbitMqTopology> topologies,
        ILogger<RabbitMqConnection> logger,
        string clientName = PrimaryName)
    {
        _options    = options?.Value ?? throw new ArgumentNullException(nameof(options));
        _topologies = topologies ?? throw new ArgumentNullException(nameof(topologies));
        _logger     = logger ?? throw new ArgumentNullException(nameof(logger));
        _clientName = clientName ?? throw new ArgumentNullException(nameof(clientName));
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
                ClientProvidedName          = _clientName,
            };

            var connection = await factory.CreateConnectionAsync(ct).ConfigureAwait(false);

            // The probe connection declares topology too, rather than skipping it as an
            // optimisation. A passive declare against a queue that does not exist yet throws, and
            // the probe reports that as a warning per queue -- so a topology-free probe connection
            // would trade a few milliseconds at startup for a burst of warnings that mean nothing.
            // Declares are idempotent, so the second run costs one channel and no semantics.
            await DeclareTopologyAsync(connection, ct).ConfigureAwait(false);

            _connection = connection;
            _logger.LogInformation(
                "broker connection open as {ClientName}; topology declared", _clientName);
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
