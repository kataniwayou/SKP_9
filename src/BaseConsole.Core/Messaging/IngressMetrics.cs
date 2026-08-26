using System.Diagnostics;
using System.Diagnostics.Metrics;
using Messaging.Transport;

namespace BaseConsole.Core.Messaging;

/// <summary>
/// Pipeline metrics for the ingress half: one measurement per delivery, whatever the consumer
/// decided to do with it.
/// <para>
/// <b><c>disposition</c> and <c>reason</c> are the two attributes that carry the decision, and each
/// answers a different question.</b> <c>disposition</c> says what happened to the delivery —
/// <c>acked</c>, <c>requeued</c>, or <c>parked</c> — the outcome an operator scans for first.
/// <c>reason</c> says why, which is what keeps the several causes behind one <c>disposition</c>
/// from averaging into a number nobody can triage. Whether the broker was actually told is not on
/// this metric at all: that survives in the consumer's own log line, where the operator deciding
/// whether to search the dead-letter queue reads it, and on a board it is answered by
/// <c>pipeline.deadletter.depth</c> instead.
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
        description: "Deliveries handled, by queue, type, and what was decided.");

    internal const string QueueWaitInstrument = "pipeline.queue.wait";

    /// <summary>
    /// Must match the name the view in <c>AddBaseConsoleObservability</c> targets. A view whose
    /// instrument name matches nothing is silently ignored, so a typo here costs the histogram its
    /// bucket boundaries and nothing reports the mistake.
    /// </summary>
    internal const string ConsumerDurationInstrument = "pipeline.consumer.duration";

    /// <summary>
    /// The bucket ladder shared by <c>pipeline.queue.wait</c> and <c>pipeline.consumer.duration</c>.
    /// **Deliberately not the transport's.**
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
    /// <para>
    /// <b>The step-elapsed measurements below are history, not a live reader.</b> That instrument
    /// was removed with the metric set of 2026-08-26; the rungs it forced stay, because they were
    /// fitted to the same operating band <c>pipeline.consumer.duration</c> now occupies.
    /// </para>
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
    /// One delivery, one measurement.
    /// <para>
    /// <b>No duration here.</b> <c>pipeline.process.duration</c> used to be recorded alongside this
    /// and measured the framework handler, which is the part that cannot vary — every hop it covers
    /// is a fixed sequence of store reads and sends. It now lives on the processor and measures the
    /// author's transform, the only span whose length is a property of someone's implementation
    /// rather than of this framework. One instrument, on the side that can actually be slow.
    /// </para>
    /// <para>
    /// <b><c>reason</c> is kept as its own tag rather than folded into <c>disposition</c>.</b>
    /// Without it, the several causes behind one <c>disposition</c> would collapse into a single
    /// number — and for <c>requeued</c> that is worse than it sounds: during any store outage every
    /// in-flight delivery bounces off the shut gate, and that benign flood would bury
    /// <c>send_failed</c> (a broker fault inside a handler) and <c>escaped</c> (an unhandled
    /// path — a bug) under it, leaving a requeue spike an operator can see but not triage.
    /// </para>
    /// <para>
    /// <b>There is no <c>landed</c> tag.</b> Whether the broker was actually told survives in the
    /// consumer's own log line, where the operator deciding whether to search the dead-letter queue
    /// reads it. On a board the same question is answered by
    /// <c>pipeline.deadletter.depth</c>: a park that did not land never arrives there.
    /// </para>
    /// </summary>
    internal static void RecordConsumed(
        string queue, string type, string disposition, string reason)
    {
        var tags = new TagList
        {
            { "queue", queue },
            { "type", type },
            { "disposition", disposition },
            { "reason", reason },
        };

        // The host's process-wide tag, if it installed one: role=leader|follower on the
        // orchestrator, absent on every other host. Read live, so a delivery handled after a
        // demotion is attributed to the follower that actually handled it.
        PipelineAmbientTag.AppendTo(ref tags);

        Consumed.Add(1, tags);
    }

    /// <summary>
    /// Records how long this delivery waited in the broker.
    /// <para>
    /// <b>Recorded ONLY if the header was present.</b> A message published by a build without this
    /// instrument carries none, and during any rollout there are always some. Recording those as
    /// zero -- or as an elapsed time since the epoch -- would bury the real distribution under a
    /// spike that means nothing.
    /// </para>
    /// <para>
    /// <b>It double-counts the publisher confirm, and a panel must subtract it.</b> The header is
    /// stamped before the publish, so the sender's own confirm -- roughly 12 of ~13ms on this stack
    /// -- sits inside this number AND inside <c>pipeline.produce.duration</c>. True broker wait is
    /// the difference. See section 7.1 of the metrics-rewrite spec for the query.
    /// </para>
    /// <para>
    /// Labelled by queue alone, matching <c>pipeline.queue.depth</c>, so the two read side by side.
    /// </para>
    /// </summary>
    internal static void RecordArrival(string queue, long? sentMs)
    {
        if (sentMs is not { } sent)
        {
            return;
        }

        var tags = new TagList { { "queue", queue } };
        PipelineAmbientTag.AppendTo(ref tags);

        QueueWait.Record(MessageClock.ElapsedSeconds(sent), tags);
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
