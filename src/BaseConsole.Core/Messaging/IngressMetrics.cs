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
