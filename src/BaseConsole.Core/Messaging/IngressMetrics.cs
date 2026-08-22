using System.Collections.Concurrent;
using System.Diagnostics;
using System.Diagnostics.Metrics;

namespace BaseConsole.Core.Messaging;

/// <summary>
/// Pipeline metrics for the ingress half: one measurement per delivery, whatever the consumer
/// decided to do with it.
/// <para>
/// <b>Intent and landing are separate attributes.</b> <c>disposition</c> and <c>reason</c> say what
/// the consumer decided; <c>landed</c> says whether the broker was ever told. Collapsing them would
/// make a gate pause during a broker blip report as a channel fault, because only one of the two
/// facts could win the slot.
/// </para>
/// </summary>
internal static class IngressMetrics
{
    /// <summary>
    /// Must match the string passed to <c>AddMeter</c> in <c>AddBaseConsoleObservability</c>. A
    /// constant rather than a literal in two places, because a typo produces no error and no
    /// metrics.
    /// </summary>
    internal const string MeterName = "BaseConsole.Core.Messaging";

    private static readonly Meter Meter = new(MeterName);

    private static readonly Counter<long> Consumed = Meter.CreateCounter<long>(
        "pipeline.messages.consumed",
        unit: "{message}",
        description: "Deliveries handled, by queue, type, what was decided, and whether the broker was told.");

    private static readonly Histogram<double> ProcessDuration = Meter.CreateHistogram<double>(
        "pipeline.process.duration",
        unit: "s",
        description: "Time spent inside the message handler. Recorded only when a handler ran.");

    private static readonly UpDownCounter<long> Inflight = Meter.CreateUpDownCounter<long>(
        "pipeline.consumer.inflight",
        unit: "{message}",
        description: "Deliveries currently inside a handler. Read against PrefetchCount for saturation.");

    private static readonly Counter<long> ChannelResets = Meter.CreateCounter<long>(
        "pipeline.consumer.channel.resets",
        unit: "1",
        description: "Times the delivery numbering was invalidated, by cause. The reason landed=false happens.");

    /// <summary>
    /// Every live consumer's subscription state, keyed by the queue it reads.
    /// <para>
    /// <b>This registry exists so there is ONE observable instrument rather than one per
    /// consumer.</b> An orchestrator holds three <see cref="GatedQueueConsumer"/> singletons, and
    /// three instruments sharing a name on one meter resolve to a single metric stream in the
    /// OpenTelemetry SDK — which warns about the duplicates and may drop them. An observable
    /// callback is allowed to return many measurements, so one gauge over a registry is the shape
    /// that reports all three.
    /// </para>
    /// </summary>
    private static readonly ConcurrentDictionary<string, Func<bool>> Consumers = new(StringComparer.Ordinal);

    static IngressMetrics()
    {
        // Registered once, in the static constructor, because an observable created more than once
        // is the duplicate-stream hazard the registry above exists to avoid. The returned instrument
        // is intentionally not stored: the Meter owns it and the callback keeps it alive.
        Meter.CreateObservableGauge(
            "pipeline.consumer.consuming",
            ObserveConsuming,
            unit: "1",
            description: "1 while a consumer holds its subscription, 0 while it is paused.");
    }

    /// <summary>
    /// Report this queue's subscription state until <see cref="UntrackConsumer"/> is called.
    /// Re-registering the same queue replaces the previous delegate rather than adding a second.
    /// </summary>
    internal static void TrackConsumer(string queue, Func<bool> isConsuming) =>
        Consumers[queue] = isConsuming;

    /// <summary>
    /// Stop reporting a queue. Without this a stopped consumer's last value would persist, and a
    /// stale 1 reads as "something is listening" for a queue nothing is reading.
    /// </summary>
    internal static void UntrackConsumer(string queue) => Consumers.TryRemove(queue, out _);

    private static IEnumerable<Measurement<int>> ObserveConsuming() =>
        Consumers.Select(entry => new Measurement<int>(
            entry.Value() ? 1 : 0,
            new KeyValuePair<string, object?>("queue", entry.Key)));

    /// <summary>Move the in-flight count for one queue. Always paired: +1 on entry, -1 in a finally.</summary>
    internal static void AddInflight(string queue, int delta) =>
        Inflight.Add(delta, new KeyValuePair<string, object?>("queue", queue));

    /// <summary>
    /// Count one invalidation of the delivery numbering. <paramref name="reason"/> is
    /// <c>shutdown</c>, <c>recovered</c> or <c>reopened</c>.
    /// </summary>
    internal static void RecordChannelReset(string queue, string reason) =>
        ChannelResets.Add(1, new TagList { { "queue", queue }, { "reason", reason } });

    /// <summary>
    /// One delivery, one measurement.
    /// <para>
    /// <paramref name="startedTimestamp"/> is null when no handler ran — a delivery rejected
    /// because the gate was shut never entered one, and recording a near-zero duration for it would
    /// make a paused consumer look fast.
    /// </para>
    /// </summary>
    internal static void RecordConsumed(
        string queue, string type, string disposition, string reason, bool landed,
        long? startedTimestamp)
    {
        var tags = new TagList
        {
            { "queue", queue },
            { "type", type },
            { "disposition", disposition },
            { "reason", reason },
            // Lower-case literals rather than a bool: an exporter is free to render a boolean tag
            // as "True", and a dashboard written against "true" would then match nothing.
            { "landed", landed ? "true" : "false" },
        };

        Consumed.Add(1, tags);

        if (startedTimestamp is { } started)
        {
            ProcessDuration.Record(
                Stopwatch.GetElapsedTime(started).TotalSeconds,
                new TagList
                {
                    { "queue", queue },
                    { "type", type },
                    { "disposition", disposition },
                });
        }
    }
}
