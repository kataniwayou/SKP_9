using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using RabbitMQ.Client;
using RabbitMQ.Client.Exceptions;

namespace Messaging.Transport;

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

    /// <summary>
    /// Called at the top of every pass, or null for a probe nobody watches.
    /// <para>
    /// <b>A callback rather than <c>ILoopHeartbeat</c>, and that is a project-reference constraint
    /// rather than a preference.</b> <c>BaseConsole.Core</c> references this assembly, so this
    /// assembly cannot name a type from it. The registration side, which can see both, passes the
    /// keyed heartbeat's <c>Beat</c> — so the stamp a liveness check reads and the counter a board
    /// draws both still come from one holder.
    /// </para>
    /// <para>
    /// <b>Required rather than optional, and that is the point.</b> A default would let a probe be
    /// registered unwatched by omission; a required parameter makes "nobody watches this one" a
    /// decision written at the call site, next to the reason for it.
    /// </para>
    /// </summary>
    private readonly Action? _beat;

    /// <summary>Queues currently failing to read, so each episode warns once rather than per tick.</summary>
    private readonly HashSet<string> _failing = [];

    /// <summary>Queues already announced, so a list that grows logs only what is new.</summary>
    private readonly HashSet<string> _announced = [];

    protected QueueStatsProbe(
        RabbitMqConnection connection,
        IReadOnlyList<string> queues,
        TimeSpan interval,
        ILogger logger,
        Action? beat)
        : this(
            connection,
            () => queues ?? throw new ArgumentNullException(nameof(queues)),
            interval,
            logger,
            onResult: null,
            beat)
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
        Action<string, ProbeOutcome>? onResult,
        Action? beat)
    {
        _connection = connection ?? throw new ArgumentNullException(nameof(connection));
        _queues     = queues ?? throw new ArgumentNullException(nameof(queues));
        _interval   = interval > TimeSpan.Zero
            ? interval
            : throw new ArgumentOutOfRangeException(nameof(interval), interval, "must be positive");
        _logger     = logger ?? throw new ArgumentNullException(nameof(logger));
        _onResult   = onResult;
        _beat       = beat;
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

    /// <summary>
    /// The loop's logger, for a subclass whose reading carries an operator-facing meaning of its own
    /// — as a consumer count does and a message count does not. Exposed rather than re-resolved so
    /// both halves of a probe write under one category.
    /// </summary>
    protected ILogger Logger => _logger;

    /// <summary>
    /// Lets a subclass drop per-queue state for queues that have left a dynamic list, alongside the
    /// pruning the loop already does for its own two sets. Without it a latched subclass would treat
    /// a queue that left and came back as one it had already reported, and the return would pass in
    /// silence — the same failure the <c>_announced</c> prune exists to prevent.
    /// </summary>
    protected virtual void PruneState(IReadOnlyCollection<string> queues)
    {
    }

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
            // FIRST, before the queue list is even resolved, and unconditionally. A pass whose
            // declares all failed has still done its job and must count as alive -- stamping
            // after the I/O, or only on success, turns a broker outage into a restart of the
            // process observing it. Same position and same reasoning as L2GateProbe's.
            _beat?.Invoke();

            var queues = _queues();

            // Prune first: a queue dropped from a dynamic registry must leave the announced
            // set too, or its return would be announced as nothing new and pass in silence.
            _announced.IntersectWith(queues);
            _failing.IntersectWith(queues);
            PruneState(queues);

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
                await WaitAsync(_interval, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    /// <summary>
    /// Waits until the next pass is due. Virtual so a subclass whose number changes on an event
    /// rather than on a clock can wake early -- see <c>DeadLetterDepthProbe</c>.
    /// </summary>
    protected virtual Task WaitAsync(TimeSpan interval, CancellationToken ct) =>
        Task.Delay(interval, ct);

    /// <summary>
    /// One passive declare on its own channel.
    /// <para>
    /// <b>Protected virtual for the reason <c>IRabbitMqConnectivityCheck</c> exists.</b>
    /// <see cref="RabbitMqConnection"/> is sealed and its <c>GetAsync</c> is not virtual, so a test
    /// holding one can only ever exercise the broker-is-up path -- there is no way to stand up a
    /// connection that fails on demand. Overriding here is what lets the heartbeat's ordering
    /// contract, which only matters when a pass measures NOTHING, be asserted at all.
    /// </para>
    /// </summary>
    protected virtual async Task<QueueDeclareOk> DeclareAsync(string queue, CancellationToken ct)
    {
        var connection = await _connection.GetAsync(ct).ConfigureAwait(false);
        var channel = await connection.CreateChannelAsync(cancellationToken: ct).ConfigureAwait(false);

        await using (channel.ConfigureAwait(false))
        {
            return await channel.QueueDeclarePassiveAsync(queue, ct).ConfigureAwait(false);
        }
    }
}
