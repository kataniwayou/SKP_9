using System.Collections.Concurrent;
using System.Diagnostics.Metrics;
using Messaging.Transport;

namespace BaseConsole.Core.Messaging;

/// <summary>
/// The standing count of work this deployment has thrown away and not dealt with.
/// <para>
/// <b>Why this exists when a parked counter already does.</b> <c>pipeline.messages.consumed</c>
/// carries <c>disposition="parked"</c> and increments correctly the moment a message is refused. But
/// a counter reports an EVENT: it rises, it is visible for one rate window, and it scrolls away.
/// Nothing afterwards reports that the message is still sitting in a queue nobody consumes.
/// </para>
/// <para>
/// <b>Measured on the live stack, which is why this is here.</b> Six parked step outcomes were found
/// in <c>orchestrator-result.dead</c>, from four incidents across two days, each one a workflow run
/// that lost progress permanently. Every board read green, all five alert rules stayed inactive, and
/// they were found only by querying the broker by hand. The counter had done its job at the time and
/// had nothing left to say two days later. A level is the only shape that can say "this is still
/// wrong".
/// </para>
/// <para>
/// <b>An observable gauge over a cache, never I/O in the callback.</b> The measurement is an AMQP
/// round trip, so it belongs on a loop — <see cref="DeadLetterDepthProbe"/> — while this side only
/// reads what the loop last saw. That split, and the single static instrument behind a registry, are
/// the pattern <c>L2GateMetrics</c> documents: an observable created more than once registers a
/// second callback on the same instrument name, which the SDK warns about and may drop.
/// </para>
/// </summary>
public static class DeadLetterDepthMetrics
{
    /// <summary>
    /// Must match the meter registered by <c>AddMeter</c> in <c>AddBaseConsoleObservability</c>. The
    /// gating meter is reused rather than a new one introduced: a typo'd meter name produces no
    /// error and no metrics, and every extra name is another chance to make that mistake.
    /// </summary>
    // POINTED AT THE CONSTANT, NEVER RESTATED AS A LITERAL. This gauge deliberately rides the
    // gate's meter rather than introducing another name, and for a while both spelled that name
    // out separately. When the gate's instruments moved into the transport and its constant was
    // repointed, this literal stayed behind: the meter it names stopped being registered by any
    // host, and pipeline.deadletter.depth silently vanished from every board -- an observable
    // gauge with nobody listening reports nothing and errors nowhere. Sharing the constant is
    // what makes that impossible to repeat.
    internal const string MeterName = GateMetrics.MeterName;

    internal const string DepthInstrument = "pipeline.deadletter.depth";

    private static readonly Meter Meter = new(MeterName);

    /// <summary>
    /// Last observed depth per queue. A level, so a second report REPLACES the first — a drained
    /// queue must stop reporting the depth it used to have.
    /// </summary>
    private static readonly ConcurrentDictionary<string, long> Depths = new();

    static DeadLetterDepthMetrics()
    {
        // Registered once, in the static constructor. The returned instrument is deliberately not
        // stored: the Meter owns it and the callback keeps it alive.
        Meter.CreateObservableGauge(
            DepthInstrument,
            Observe,
            // "{message}", NOT "1". A unit of "1" makes the Prometheus exporter append a `_ratio`
            // suffix -- that is where pipeline_gate_open_ratio's name comes from, and it is correct
            // there because that gauge IS a ratio. Here it produced pipeline_deadletter_depth_ratio
            // for a count of messages: a wrong name, and a panel querying the obvious one silently
            // matched nothing and rendered a confident green 0 while the broker held 7. Curly braces
            // are OpenTelemetry's annotation form and carry no suffix.
            unit: "{message}",
            description: "Messages sitting in a dead-letter queue: work refused and not yet dealt with.");
    }

    /// <summary>
    /// Publish the depth <paramref name="queue"/> was last seen holding.
    /// </summary>
    /// <remarks>
    /// <b>Zero is a report, not a silence.</b> An empty dead-letter queue is the healthy state and
    /// has to be visibly zero, because an absent series cannot be told apart from an instrument
    /// nobody wired — the same trap the fault panels close with <c>or vector(0)</c>.
    /// </remarks>
    public static void Report(string queue, long depth)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(queue);
        Depths[queue] = depth;
    }

    private static IEnumerable<Measurement<long>> Observe() =>
        Depths.Select(e => new Measurement<long>(
            e.Value, new KeyValuePair<string, object?>("queue", e.Key)));
}
