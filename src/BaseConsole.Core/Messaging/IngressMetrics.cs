using System.Collections.Concurrent;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using Messaging.Transport;

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

    private static readonly UpDownCounter<long> Inflight = Meter.CreateUpDownCounter<long>(
        "pipeline.consumer.inflight",
        unit: "{message}",
        description: "Deliveries currently inside a handler. Read against PrefetchCount for saturation.");

    private static readonly Counter<long> ChannelResets = Meter.CreateCounter<long>(
        "pipeline.consumer.channel.resets",
        unit: "1",
        description: "Times the delivery numbering was invalidated, by cause. This is why landed=false happens.");

    internal const string QueueWaitInstrument = "pipeline.queue.wait";
    internal const string StepElapsedInstrument = "pipeline.step.elapsed";

    /// <summary>
    /// Must match the name the view in <c>AddBaseConsoleObservability</c> targets. A view whose
    /// instrument name matches nothing is silently ignored, so a typo here costs the histogram its
    /// bucket boundaries and nothing reports the mistake.
    /// </summary>
    internal const string ConsumerDurationInstrument = "pipeline.consumer.duration";

    /// <summary>
    /// The bucket ladder for the two arrival histograms. **Deliberately not the transport's.**
    /// <para>
    /// <c>EgressMeter.LatencySecondsBoundaries</c> stops at 10s, which is right for a broker round
    /// trip and wrong here: the whole reason these instruments exist is a pipeline falling behind,
    /// and a backlogged step is measured in minutes. Everything past the last boundary lands in
    /// <c>+Inf</c>, where a quantile has nothing to interpolate between and reports the last edge —
    /// which is exactly the defect that made a 15ms send read as 4.9s, in the other direction.
    /// </para>
    /// <para>
    /// The low end starts at 10ms rather than 1ms, and that is honesty rather than laziness: both
    /// ends of these measurements are stamped on different processes, so nothing below NTP skew is
    /// a real number. A ladder resolving 1ms would invite someone to read a figure that is noise.
    /// </para>
    /// </summary>
    /// <remarks>
    /// <b>Six rungs were added on 2026-08-25, all of them ABOVE the 10ms floor.</b> The floor is the
    /// honesty limit the paragraph above states and it has not moved; what changed is that the rungs
    /// resting on it were wider than the system they measure, so the quantiles they fed were
    /// arithmetic between two edges rather than measurements.
    /// <list type="bullet">
    /// <item><description><c>0.015</c>, <c>0.02</c> — queue-wait means sit at 11-14ms on every hop,
    /// which put <b>51%</b> of samples in one <c>(10, 25]</c> rung and pinned p95 at 24.4ms because
    /// 25 is a boundary.</description></item>
    /// <item><description><c>0.03</c>, <c>0.04</c>, <c>0.06</c>, <c>0.075</c> — step elapsed means
    /// ~40ms with a tail to 76ms, which put <b>90%</b> of samples in <c>(25, 50]</c> and the tail in
    /// <c>(50, 100]</c>. The panel reported p95 86ms and p99 97ms against 54ms and 62ms measured
    /// from the orchestrator's own logs over the same window.</description></item>
    /// </list>
    /// <b>Expect every quantile panel fed by these two instruments to drop when this ships.</b> That
    /// is the interpolation being removed, not the pipeline getting faster.
    /// <para>
    /// <c>0.065</c> was added after measuring the result of the six above. Step-elapsed p95 came
    /// back within 13% of the truth but p99 still overstated by 29%, because the last ~1% of samples
    /// had moved into <c>(60, 75]</c> and sat against its bottom edge — ES put the true maximum at
    /// 61ms. That is the same shape <c>(50, 100]</c> had before, one rung along, and the tail is
    /// exactly where a p99 reads. Splitting it is the second half of the same fix, not a new one.
    /// </para>
    /// <para>
    /// <c>0.125, 0.15, 0.175, 0.2</c> close the last gap in the operating band. Everything above was
    /// fitted to the three-step probe workflow, which lives near 32ms; the ten-step fanout workflow
    /// lives near <b>114ms with a tail to ~180ms</b>, i.e. entirely inside what was a single 150ms
    /// rung — the original defect, unmoved, waiting for the workload to come back. Between 10ms and
    /// 250ms no rung now spans more than <b>1.5x</b>, which caps the worst-case overstatement of any
    /// quantile at half a rung wherever either workload happens to sit. That property is asserted in
    /// <c>ArrivalHistogramBucketTests</c>, deliberately as a property rather than a boundary list,
    /// because the list is what keeps going stale.
    /// </para>
    /// <para>
    /// Outside the band the ladder stays coarse on purpose: below 10ms is the skew floor above, and
    /// above 250ms is backlog territory where an order of magnitude is the interesting distinction.
    /// </para>
    /// </remarks>
    public static double[] ArrivalSecondsBoundaries() =>
    [
        0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.06, 0.065, 0.075, 0.1, 0.125, 0.15, 0.175, 0.2, 0.25,
        0.5, 1, 2.5, 5, 10, 30, 60, 120, 300,
    ];

    /// <summary>
    /// How long this delivery sat in the broker: the term neither produce duration nor process
    /// duration contains, and therefore the one that goes missing when an end-to-end time grows.
    /// </summary>
    private static readonly Histogram<double> QueueWait = Meter.CreateHistogram<double>(
        QueueWaitInstrument,
        unit: "s",
        description: "Seconds between a message being published and a consumer picking it up.");

    /// <summary>
    /// Seconds since the step that caused this message was dispatched. On a
    /// <c>step-outcome</c> delivery at the orchestrator this is the whole door-to-door step time —
    /// the only measurement here of what a workflow experiences rather than what a component does.
    /// </summary>
    private static readonly Histogram<double> StepElapsed = Meter.CreateHistogram<double>(
        StepElapsedInstrument,
        unit: "s",
        description: "Seconds since the step that caused this message began.");

    /// <summary>
    /// How long a delivery was held, from arrival to whatever the consumer decided.
    /// <para>
    /// <b>Recorded on every terminal path, which is what its predecessor could not do.</b>
    /// <c>pipeline.process.duration</c> measured only the author's transform, so a delivery parked
    /// for lacking a handler, or bounced off a shut gate, cost nothing that any instrument reported.
    /// The <c>disposition</c> tag is what keeps a slow success and a slow refusal from averaging
    /// into a number describing neither.
    /// </para>
    /// </summary>
    private static readonly Histogram<double> ConsumerDuration = Meter.CreateHistogram<double>(
        ConsumerDurationInstrument,
        unit: "s",
        description: "Seconds a delivery was held, whatever the consumer decided to do with it.");

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
    /// <b>No duration here.</b> <c>pipeline.process.duration</c> used to be recorded alongside this
    /// and measured the framework handler, which is the part that cannot vary — every hop it covers
    /// is a fixed sequence of store reads and sends. It now lives on the processor and measures the
    /// author's transform, the only span whose length is a property of someone's implementation
    /// rather than of this framework. One instrument, on the side that can actually be slow.
    /// </para>
    /// </summary>
    internal static void RecordConsumed(
        string queue, string type, string disposition, string reason, bool landed)
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

        // The host's process-wide tag, if it installed one: role=leader|follower on the
        // orchestrator, absent on every other host. Read live, so a delivery handled after a
        // demotion is attributed to the follower that actually handled it.
        PipelineAmbientTag.AppendTo(ref tags);

        Consumed.Add(1, tags);
    }

    /// <summary>
    /// Records how long this delivery waited in the broker, and how long the step that caused it has
    /// been running.
    /// <para>
    /// <b>Each is recorded ONLY if its header was present.</b> A message published by a build
    /// without these instruments carries neither, and during any rollout there are always some.
    /// Recording those as zero — or as an elapsed time since the epoch — would bury the real
    /// distribution under a spike that means nothing. The two are independent: the API publishes
    /// through a copy of the sender that stamps nothing, so a message can plausibly arrive with one
    /// and not the other.
    /// </para>
    /// <para>
    /// Recorded before the handler runs rather than after, deliberately: this measures the time the
    /// message spent waiting to be picked up, and adding the handler's own duration would fold in
    /// the number <c>pipeline.process.duration</c> already reports on its own.
    /// </para>
    /// </summary>
    internal static void RecordArrival(string queue, string type, long? sentMs, long? originMs)
    {
        var tags = new TagList { { "queue", queue }, { "type", type } };
        PipelineAmbientTag.AppendTo(ref tags);

        if (sentMs is { } sent)
        {
            QueueWait.Record(MessageClock.ElapsedSeconds(sent), tags);
        }

        if (originMs is { } origin)
        {
            StepElapsed.Record(MessageClock.ElapsedSeconds(origin), tags);
        }
    }

    /// <summary>Records one delivery's cost, on whichever path it ended.</summary>
    internal static void RecordConsumerDuration(
        string queue, string type, string disposition, double seconds)
    {
        var tags = new TagList
        {
            { "queue", queue },
            { "type", type },
            { "disposition", disposition },
        };

        PipelineAmbientTag.AppendTo(ref tags);

        ConsumerDuration.Record(seconds, tags);
    }
}
