using System.Collections.Concurrent;
using System.Diagnostics.Metrics;

namespace Messaging.Transport;

/// <summary>
/// How much work is waiting in this process's live queues, and how many consumers the BROKER
/// believes are attached to them.
/// <para>
/// <b>Why depth, when the hop gaps already count messages.</b> The hop-gap stats are a conservation
/// check — produced minus consumed — and a conservation check cannot tell a message sitting in a
/// queue from a message that vanished. Both render as a gap. Depth is the term that separates them:
/// a gap roughly equal to the depth is backlog, a gap far exceeding it is loss. Until this existed,
/// no panel anywhere could make that distinction.
/// </para>
/// <para>
/// <b>It is the only leading indicator on these boards.</b> Every other verdict signal is coincident
/// or lagging. <c>consuming</c> drops once the consumer has already stopped; data freshness degrades
/// after exports stop; a departed replica takes a liveness window plus an export to notice, measured
/// at 52–66s. Depth climbs while every one of those is still green, because a consumer merely
/// <i>slower</i> than its producer is not broken by any of their definitions — and that is the shape
/// of most real degradations.
/// </para>
/// <para>
/// <b>Consumers is broker-side truth, which nothing else here is.</b> The pipeline used to also
/// carry <c>pipeline.consumer.consuming</c>, the process asserting its own health. That assertion had
/// to be wrapped in a liveness window on every board, because a dead replica's copy of it was held at
/// 1 by the collector and by Prometheus's lookback. This count comes from the broker's own reply to a
/// passive declare instead, so it is 0 the moment a consumer detaches and needs no window at all —
/// which is why the self-asserted gauge was removed rather than kept alongside it: this one answers
/// the same question without the window the other one required. It is not a complete answer either: a
/// consumer that reattaches inside one probe interval — which is exactly what the S9 scenario
/// produced — is still invisible here.
/// </para>
/// <para>
/// <b>Depth counts messages READY, not unacked.</b> That is what a passive declare returns. It is
/// accurate here because <c>PrefetchCount</c> is 1, so at most one message per consumer is in flight
/// and unaccounted for. Raising prefetch would make this undercount by up to the prefetch times the
/// consumer count, and this comment is the only place that dependency is written down.
/// </para>
/// </summary>
public static class QueueDepthMetrics
{
    /// <summary>
    /// Its own meter, and the one place this name is written. Every host that wants queue depth
    /// must pass it to <c>AddMeter</c> -- the console base does so for the workers, and the API
    /// does so directly, because the API is not a console and shares none of that wiring.
    /// <para>
    /// A NEW name rather than the gating meter these instruments used to share. That meter is
    /// <c>BaseConsole.Core.Gating</c>, registered by <c>AddBaseConsoleObservability</c>, and it is
    /// unreachable from here now that this type lives in the transport -- which is where it had to
    /// move for the API to run a probe at all. Changing the meter does not change the exported
    /// metric names, so nothing on the dashboards moves.
    /// </para>
    /// <para>
    /// A typo'd meter name produces no error and no metrics, which is why this is a constant every
    /// registration reads rather than a literal written twice.
    /// </para>
    /// </summary>
    public const string MeterName = "Messaging.Transport.Queues";

    internal const string DepthInstrument = "pipeline.queue.depth";
    internal const string ConsumersInstrument = "pipeline.queue.consumers";

    private static readonly Meter Meter = new(MeterName);

    /// <summary>
    /// Last observed stats per queue. A level, so a second report REPLACES the first — a drained
    /// queue must stop reporting the depth it used to have.
    /// </summary>
    private static readonly ConcurrentDictionary<string, Stats> Observed = new();

    static QueueDepthMetrics()
    {
        // Registered once, in the static constructor. The returned instruments are deliberately not
        // stored: the Meter owns them and the callbacks keep them alive.
        //
        // "{message}" and "{consumer}", NOT "1". A unit of "1" makes the Prometheus exporter append
        // a `_ratio` suffix — that is where pipeline_gate_open_ratio's name comes from, and it is
        // correct there because that gauge IS a ratio. On pipeline.deadletter.depth the same
        // mistake produced pipeline_deadletter_depth_ratio for a count of messages, and the panel
        // querying the obvious name matched nothing and rendered a confident green 0 while the
        // broker held 7. Curly braces are OpenTelemetry's annotation form and carry no suffix.
        Meter.CreateObservableGauge(
            DepthInstrument,
            () => Snapshot(s => s.Depth),
            unit: "{message}",
            description: "Messages ready in a live queue: work that has arrived and not been taken.");

        Meter.CreateObservableGauge(
            ConsumersInstrument,
            () => Snapshot(s => s.Consumers),
            unit: "{consumer}",
            description: "Consumers the broker has attached to a live queue. Zero means nothing is "
                       + "listening, reported by the broker rather than by the process itself.");
    }

    /// <summary>
    /// Publish what <paramref name="queue"/> was last seen holding, and how many consumers the
    /// broker reported on it.
    /// </summary>
    /// <remarks>
    /// <b>Zero is a report, not a silence</b>, for both values. An empty work queue is the healthy
    /// state and an absent series cannot be told apart from an instrument nobody wired. Zero
    /// consumers is the fault this gauge exists to catch, which makes it the one value that must
    /// never be expressed as a missing series.
    /// </remarks>
    public static void Report(string queue, long depth, long consumers)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(queue);
        Observed[queue] = new Stats(depth, consumers);
    }

    private static IEnumerable<Measurement<long>> Snapshot(Func<Stats, long> select) =>
        Observed.Select(e => new Measurement<long>(
            select(e.Value), new KeyValuePair<string, object?>("queue", e.Key)));

    private readonly record struct Stats(long Depth, long Consumers);
}
