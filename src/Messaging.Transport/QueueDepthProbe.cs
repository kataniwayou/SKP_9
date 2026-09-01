using Microsoft.Extensions.Logging;
using RabbitMQ.Client;

namespace Messaging.Transport;

/// <summary>
/// Reads how much work is waiting in this process's LIVE queues, and how many consumers the broker
/// has attached to them, on a loop.
/// <para>
/// The loop itself lives in <see cref="QueueStatsProbe"/> and is shared with
/// <see cref="DeadLetterDepthProbe"/>. What this class adds is the queue list's meaning, the second
/// value, and a much shorter interval.
/// </para>
/// <para>
/// <b>Why the interval is short where the dead-letter probe's is long.</b> A dead-letter queue
/// changes when something is refused: rarely, and never urgently. A work queue changes continuously,
/// and the whole value of depth is that it MOVES BEFORE anything else does — a backlog that has
/// already been drained by the time it is sampled tells an operator nothing. The services export
/// OTLP every 10s against a 15s scrape, so an interval above ~10s would make the probe, rather than
/// the pipeline, the thing the boards are watching.
/// </para>
/// <para>
/// <b>What it costs.</b> One channel open and close per queue per pass — the blast-radius trade
/// <see cref="QueueStatsProbe"/> explains. At four queues on a ten-second interval that is 0.4
/// channels a second per replica, against 0.01 for the dead-letter probe's three queues at five
/// minutes. Trivial for a broker, and worth stating because it is the price of the resolution above.
/// </para>
/// <para>
/// <b>Every replica reports the same numbers for a shared queue, and that redundancy is wanted.</b>
/// A queue depth is a property of the broker rather than of the replica asking, so the value
/// survives any one replica going away — which is exactly when an operator wants it. A board reads
/// it with <c>max by (queue)</c> rather than <c>sum</c>, which would multiply the depth by the
/// replica count. The dead-letter panels already carry that pattern and the reasoning behind it.
/// </para>
/// </summary>
public sealed class QueueDepthProbe : QueueStatsProbe
{
    public QueueDepthProbe(
        RabbitMqConnection connection,
        IReadOnlyList<string> queues,
        TimeSpan interval,
        ILogger<QueueDepthProbe> logger,
        Action? beat)
        : base(connection, queues, interval, logger, beat)
    {
    }

    /// <summary>
    /// Resolves its queue list every pass. Used by the orchestrator, whose processor work queues are
    /// per-processor GUIDs that only exist once something has been dispatched to them.
    /// </summary>
    public QueueDepthProbe(
        RabbitMqConnection connection,
        Func<IReadOnlyList<string>> queues,
        TimeSpan interval,
        ILogger<QueueDepthProbe> logger,
        Action<string, ProbeOutcome>? onResult,
        Action? beat)
        : base(connection, queues, interval, logger, onResult, beat)
    {
    }

    /// <summary>
    /// Queues already reported as having no consumer, so each episode is reported once rather than
    /// every tick. The same latch the base class keeps for unreadable queues, and kept for the same
    /// reason: a ten-second loop that logged the condition rather than the transition would bury it.
    /// </summary>
    private readonly HashSet<string> _starved = [];

    /// <summary>Consecutive passes each queue has now read zero consumers.</summary>
    private readonly Dictionary<string, int> _idleFor = [];

    /// <summary>
    /// How many consecutive zero-consumer passes a queue must read before it is worth saying so.
    /// <para>
    /// <b>This is not tuning; it is the difference between a signal and a false alarm.</b> A service's
    /// first probe pass runs before its own consumers have attached — the L2 gate alone holds them
    /// for two healthy probes at five seconds, and hydration runs after that — so a probe that warned
    /// on the first reading announced every queue the process was about to consume itself. Observed
    /// on the orchestrator: four warnings at startup, three of which retracted themselves seconds
    /// later, with the one true positive sitting unnoticed among them.
    /// </para>
    /// <para>
    /// Three passes is ~30s at this probe's interval, comfortably past that window. It costs nothing
    /// against the case this exists to catch: a queue with no consumer because the service that
    /// drains it was never deployed stays that way for as long as the operator takes to notice.
    /// </para>
    /// </summary>
    private const int PassesBeforeReporting = 3;

    protected override string Purpose => "queue depth";

    /// <inheritdoc/>
    protected override void PruneState(IReadOnlyCollection<string> queues)
    {
        _starved.IntersectWith(queues);

        foreach (var gone in _idleFor.Keys.Where(q => !queues.Contains(q)).ToList())
        {
            _idleFor.Remove(gone);
        }
    }

    /// <summary>
    /// Publishes the reading, and says out loud the one thing in it an operator cannot infer from
    /// anywhere else.
    /// <para>
    /// <b>Why this belongs here and not on <see cref="DeadLetterDepthProbe"/>.</b> A dead-letter
    /// queue has no consumer by design; warning about it would be warning that the system works. A
    /// LIVE queue with no consumer is the opposite — every message on it is work that will not run —
    /// and the count has been read on this loop all along, reported to Prometheus and never once
    /// stated in the log. That gap is what let a service run green and busy while dispatching into
    /// queues nothing was reading.
    /// </para>
    /// </summary>
    protected override void Report(string queue, QueueDeclareOk ok)
    {
        QueueDepthMetrics.Report(queue, (long)ok.MessageCount, (long)ok.ConsumerCount);

        if (ok.ConsumerCount == 0)
        {
            // Counted before it is reported: see PassesBeforeReporting for why the first reading of
            // this condition is not worth a line.
            _idleFor[queue] = _idleFor.TryGetValue(queue, out var passes) ? passes + 1 : 1;

            if (_idleFor[queue] >= PassesBeforeReporting && _starved.Add(queue))
            {
                // The depth rides the line because the two numbers mean different things together
                // than apart: no consumer and nothing waiting is a service not yet started, while no
                // consumer and a backlog is work already stranded.
                Logger.LogWarning(
                    "no consumer on {Queue} — {Depth} message(s) waiting; {Remedy}",
                    queue,
                    ok.MessageCount,
                    queue.StartsWith("processor-", StringComparison.Ordinal)
                        ? "this is a processor work queue, so nothing will run these until a "
                          + "processor for it is deployed and has resolved its identity"
                        : "nothing will read these until the service that owns the queue is running");
            }
        }
        else
        {
            _idleFor.Remove(queue);

            // Only for a queue that was actually reported: "again" has to answer a line the operator
            // has already read, or it describes a recovery from nothing.
            if (_starved.Remove(queue))
            {
                Logger.LogInformation(
                    "{Queue} has {ConsumerCount} consumer(s) again; {Depth} message(s) waiting",
                    queue, ok.ConsumerCount, ok.MessageCount);
            }
        }
    }
}
