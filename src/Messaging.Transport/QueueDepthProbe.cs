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

    protected override string Purpose => "queue depth";

    protected override void Report(string queue, QueueDeclareOk ok) =>
        QueueDepthMetrics.Report(queue, (long)ok.MessageCount, (long)ok.ConsumerCount);
}
