using System.Collections.Concurrent;
using System.Diagnostics.Metrics;
using System.Runtime.CompilerServices;

namespace Messaging.Transport;

/// <summary>
/// The iteration counter every watched loop in the stack reports through, whichever host it runs in.
/// <para>
/// <b>It lives in the transport for the reason <see cref="QueueDepthMetrics"/> does.</b> The counter
/// used to sit on <c>CountingLoopHeartbeat</c> in the console base library, which the API cannot
/// reference -- <c>BaseApi.Core</c> carries its own <c>ILoopHeartbeat</c>, a deliberate copy. Two
/// hosts running the same loops could not report through one instrument until the instrument moved
/// below both of them.
/// </para>
/// <para>
/// <b>The meter name changed and the instrument name did not</b>, which is the whole point: a meter
/// name is a registration detail, and the exported Prometheus name comes from the instrument. So
/// `pipeline_loop_iterations_total` is untouched and no panel moves, exactly as when queue depth
/// made this same journey.
/// </para>
/// </summary>
public static class LoopMetrics
{
    /// <summary>
    /// Must match the string every host passes to <c>AddMeter</c>. A constant rather than a literal
    /// in four places, because a typo produces no error and no metrics.
    /// </summary>
    public const string MeterName = "Messaging.Transport.Loop";

    public const string IterationsInstrument = "pipeline.loop.iterations";

    private static readonly Meter Meter = new(MeterName);

    /// <summary>
    /// Iterations completed, by loop name. A registry behind an observable rather than a
    /// <see cref="Counter{T}"/> -- see the observable's registration below for why the seed cannot
    /// be a pushed measurement.
    /// </summary>
    private static readonly ConcurrentDictionary<string, StrongBox<long>> Loops =
        new(StringComparer.Ordinal);

    static LoopMetrics()
    {
        // OBSERVABLE, NOT A COUNTER, AND THAT IS WHAT MAKES Seed WORK AT ALL.
        //
        // A pushed measurement reaches only the readers subscribed at the instant it is taken, and
        // every seed here is taken too early to have one: CountingLoopHeartbeat seeds from its
        // CONSTRUCTOR and the queue-depth loop seeds during composition, both of them before the
        // OpenTelemetry hosted service has built the MeterProvider. So the seed landed with no
        // reader attached and created no metric point, and a loop that never ran exported nothing
        // -- the exact failure the seed exists to express. Every loop series on the live stack was
        // present only because the loop was in fact running and incrementing.
        //
        // An observable is immune to that ordering because it is polled rather than pushed: the
        // provider asks at collection time, long after it exists.
        //
        // The unit stays {iteration} rather than "1": a unit of "1" makes the Prometheus exporter
        // append _ratio to a gauge, which has already cost this repository one panel that matched
        // nothing and rendered a confident green zero.
        Meter.CreateObservableCounter(
            IterationsInstrument,
            Observe,
            unit: "{iteration}",
            description: "Iterations completed by a named loop. Its rate is the loop's liveness.");
    }

    /// <summary>
    /// Publishes <paramref name="loop"/> at zero.
    /// <para>
    /// <b>LOAD-BEARING, and not an optimisation.</b> An instrument that has reported nothing exports
    /// no series at all, so a loop that failed to start would produce no data -- and a panel
    /// comparing <c>rate()</c> against a threshold has nothing to compare. The exact failure the
    /// metric exists to catch would be the one it could not express.
    /// </para>
    /// </summary>
    public static void Seed(string loop) => Slot(loop);

    /// <summary>Records one completed iteration of <paramref name="loop"/>.</summary>
    public static void Count(string loop) => Interlocked.Increment(ref Slot(loop).Value);

    private static StrongBox<long> Slot(string loop)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(loop);
        return Loops.GetOrAdd(loop, _ => new StrongBox<long>());
    }

    private static IEnumerable<Measurement<long>> Observe() =>
        Loops.Select(entry => new Measurement<long>(
            Interlocked.Read(ref entry.Value.Value),
            new KeyValuePair<string, object?>("loop", entry.Key)));
}
