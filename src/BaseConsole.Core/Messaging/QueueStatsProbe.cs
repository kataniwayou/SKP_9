using Messaging.Transport;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using RabbitMQ.Client;
using RabbitMQ.Client.Exceptions;

namespace BaseConsole.Core.Messaging;

/// <summary>
/// Reads what the broker says about a fixed list of queues, on a loop, and hands each reading to a
/// subclass to publish. The shared half of <see cref="DeadLetterDepthProbe"/> and
/// <see cref="QueueDepthProbe"/>.
/// <para>
/// <b>One loop, two probes, deliberately.</b> The two ask the same question of the broker and
/// differ only in which queues they name and what they do with the answer. Everything difficult
/// here — the
/// passive declare, the channel-per-pass, the warning latch, the swallowed failure — is difficult
/// for both, and a second copy would be a second place for it to be got wrong. This is the same
/// reasoning that emits the shared dashboard panels from one function.
/// </para>
/// <para>
/// <b>Passive declare, not the management API and not a broker exporter.</b> <c>queue.declare</c>
/// with <c>passive</c> returns the queue's message and consumer counts over the AMQP connection this
/// process already holds, inside the vhost it was given. That matters because the broker and
/// Prometheus are both org-owned in production: a scrape target cannot be added, a plugin cannot be
/// enabled, and broker-wide metrics would span other tenants' queues. Everything here travels the
/// same path as every other pipeline metric — OTLP to the collector — and needs nothing from anyone.
/// </para>
/// <para>
/// <b>A fresh channel per pass, deliberately.</b> A passive declare against a queue that does not
/// exist does not return an error to the caller: the broker closes the CHANNEL with a 404. Sharing
/// one long-lived channel would mean a single missing queue silently killed every later reading on
/// it. A channel per pass costs one round trip per interval and contains the blast radius to the
/// queue that was actually missing.
/// </para>
/// <para>
/// <b>Failure is logged and swallowed, never fatal.</b> This is an observability loop; a process
/// that died because it could not measure its own queues would have turned a reporting gap into an
/// outage. The gauge simply keeps reporting the last value it saw, which is why the staleness of the
/// whole telemetry path is already covered by <c>TelemetryStale</c>.
/// </para>
/// </summary>
public abstract class QueueStatsProbe : BackgroundService
{
    private readonly RabbitMqConnection _connection;
    private readonly Func<IReadOnlyList<string>> _queues;
    private readonly TimeSpan _interval;
    private readonly ILogger _logger;

    /// <summary>Queues currently failing to read, so each episode warns once rather than per tick.</summary>
    private readonly HashSet<string> _failing = [];

    /// <summary>Queues already announced, so a list that grows logs only what is new.</summary>
    private readonly HashSet<string> _announced = [];

    protected QueueStatsProbe(
        RabbitMqConnection connection,
        IReadOnlyList<string> queues,
        TimeSpan interval,
        ILogger logger)
        : this(connection, () => queues ?? throw new ArgumentNullException(nameof(queues)), interval, logger)
    {
        ArgumentNullException.ThrowIfNull(queues);
    }

    /// <summary>
    /// Resolves the queue list on EVERY pass rather than once at construction.
    /// <para>
    /// Needed because the queues that matter most are not known at startup. Processor work queues
    /// are per-processor GUIDs resolved from the workflow graph at run time, so the orchestrator --
    /// the process that must measure them, because it outlives the processors -- can only name them
    /// once it has dispatched to one. See <see cref="DispatchedQueues"/> for the measurement that
    /// forced this.
    /// </para>
    /// </summary>
    protected QueueStatsProbe(
        RabbitMqConnection connection,
        Func<IReadOnlyList<string>> queues,
        TimeSpan interval,
        ILogger logger,
        Action<string, ProbeOutcome>? onResult = null)
    {
        _connection = connection ?? throw new ArgumentNullException(nameof(connection));
        _queues     = queues ?? throw new ArgumentNullException(nameof(queues));
        _interval   = interval > TimeSpan.Zero
            ? interval
            : throw new ArgumentOutOfRangeException(nameof(interval), interval, "must be positive");
        _logger     = logger ?? throw new ArgumentNullException(nameof(logger));
        _onResult   = onResult;
    }

    /// <summary>
    /// Tells a dynamic queue registry what each pass learned, so a queue the broker says is gone
    /// stops being probed. Optional, because a statically-configured list has nothing to forget.
    /// </summary>
    private readonly Action<string, ProbeOutcome>? _onResult;

    /// <summary>
    /// A passive declare against a missing queue is answered by the broker closing the CHANNEL with
    /// a 404, which the client surfaces as this. Distinguishing it from every other failure is what
    /// makes dropping a queue safe: an unreachable broker fails every queue at once, and treating
    /// that as "gone" would empty the registry at the exact moment the backlog it exists to measure
    /// was building.
    /// </summary>
    private static ProbeOutcome Classify(Exception ex) =>
        ex is OperationInterruptedException oi && oi.ShutdownReason?.ReplyCode == 404
            ? ProbeOutcome.Missing
            : ProbeOutcome.Failed;

    /// <summary>
    /// What this probe is for, in a few words, used in its start-up and failure log lines. A probe
    /// that could not be told apart from another one in the log would make two loops in the same
    /// process indistinguishable at exactly the moment that matters.
    /// </summary>
    protected abstract string Purpose { get; }

    /// <summary>Publish one reading. Called once per queue per pass.</summary>
    protected abstract void Report(string queue, QueueDeclareOk ok);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // The only record that this loop exists at all. Without it, "the probe never started" and
        // "the probe is running and the queues are empty" are the same observation from outside the
        // process -- both are silence plus a gauge reading zero. That ambiguity cost a debugging
        // cycle on the dead-letter probe.
        //
        // Logged every pass that brings a NEW queue rather than once at startup, because a dynamic
        // list starts empty and fills as work flows. A single start-up line would name the empty set
        // and never mention the queues that actually got measured.
        _logger.LogInformation(
            "{Purpose} probe starting, every {Interval}", Purpose, _interval);

        while (!stoppingToken.IsCancellationRequested)
        {
            var queues = _queues();

            // Prune first: a queue dropped from a dynamic registry must leave the announced
            // set too, or its return would be announced as nothing new and pass in silence.
            _announced.IntersectWith(queues);
            _failing.IntersectWith(queues);

            var added = queues.Where(q => _announced.Add(q)).ToList();
            if (added.Count > 0)
            {
                _logger.LogInformation(
                    "{Purpose} probe now watching {QueueCount} queue(s); added: {Queues}",
                    Purpose, queues.Count, string.Join(", ", added));
            }

            foreach (var queue in queues)
            {
                try
                {
                    Report(queue, await DeclareAsync(queue, stoppingToken).ConfigureAwait(false));
                    _onResult?.Invoke(queue, ProbeOutcome.Ok);

                    // Recovered: re-arm the warning so the next episode is reported too.
                    if (_failing.Remove(queue))
                    {
                        _logger.LogInformation("reading {Queue} again for {Purpose}", queue, Purpose);
                    }
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex)
                {
                    // ONE WARNING PER QUEUE PER EPISODE, then silence until it recovers.
                    //
                    // This was written at Debug first, to keep a broker outage from logging once per
                    // queue per interval for its whole length. That made a probe which could not
                    // measure ANYTHING indistinguishable from a probe reporting zero -- the gauge had
                    // no series, the board's `or vector(0)` rendered a confident green 0 while the
                    // broker held 7, and nothing anywhere said why. Debug is below the level shipped
                    // to the log store, which is the same trap WorkflowActivator documents for its
                    // own control-plane record.
                    //
                    // Latching keeps the outage case quiet without making the broken case silent.
                    if (_failing.Add(queue))
                    {
                        _logger.LogWarning(ex, "could not read {Queue} for {Purpose}", queue, Purpose);
                    }

                    _onResult?.Invoke(queue, Classify(ex));
                }
            }

            try
            {
                await Task.Delay(_interval, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private async Task<QueueDeclareOk> DeclareAsync(string queue, CancellationToken ct)
    {
        var connection = await _connection.GetAsync(ct).ConfigureAwait(false);
        var channel = await connection.CreateChannelAsync(cancellationToken: ct).ConfigureAwait(false);

        await using (channel.ConfigureAwait(false))
        {
            return await channel.QueueDeclarePassiveAsync(queue, ct).ConfigureAwait(false);
        }
    }
}
