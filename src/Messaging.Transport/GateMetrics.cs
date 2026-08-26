using System.Collections.Concurrent;
using System.Diagnostics.Metrics;

namespace Messaging.Transport;

/// <summary>
/// The projection-store gate's three instruments, for whichever host owns a gate.
/// <para>
/// <b>It lives in the transport because the gate does not.</b> <c>BaseConsole.Core.Gating.L2Gate</c>
/// and <c>BaseApi.Core.Gating.L2Gate</c> are deliberate copies of one another and the two libraries
/// do not reference each other, so an instrument owned by either could only ever measure half the
/// stack. This type knows nothing about a gate: it observes a <see cref="Func{Boolean}"/>, which
/// both copies can supply.
/// </para>
/// <para>
/// The instrument names are unchanged, so no panel moves; only the meter name is new. That is the
/// same trade <see cref="QueueDepthMetrics"/> made when it moved here for the same reason.
/// </para>
/// </summary>
public static class GateMetrics
{
    /// <summary>
    /// Must match the string every host passes to <c>AddMeter</c>. A constant rather than a literal
    /// in three places, because a typo produces no error and no metrics.
    /// </summary>
    public const string MeterName = "Messaging.Transport.Gate";

    public const string ProbeDurationInstrument = "pipeline.gate.probe.duration";

    private static readonly Meter Meter = new(MeterName);

    /// <summary>
    /// Every registered gate's open-state reader, keyed by the token handed back to the owner.
    /// <para>
    /// A registry rather than an observable per owner: <c>CreateObservableGauge</c> cannot be undone
    /// short of disposing the <see cref="Meter"/>, so one created per instance leaks a live callback
    /// every time one is constructed -- every test included. This keeps exactly one callback alive
    /// for the process's lifetime.
    /// </para>
    /// </summary>
    private static readonly ConcurrentDictionary<object, Func<bool>> Gates = new();

    private static readonly Counter<long> Trips = Meter.CreateCounter<long>(
        "pipeline.gate.trips",
        unit: "1",
        description: "Times the projection store went away and consumption was paused at the broker.");

    /// <summary>
    /// How long the store took to answer the gate probe.
    /// <para>
    /// The instrument the gate could not substitute for. The gate answers "did the store reply inside
    /// ProbeTimeout", which is a yes/no: Redis made 685x slower -- 0.44ms to 301ms, measured -- moved
    /// nothing on any board, because a store a thousand times slower and still inside a 2s budget is,
    /// to a yes/no, a healthy store.
    /// </para>
    /// </summary>
    private static readonly Histogram<double> ProbeDuration = Meter.CreateHistogram<double>(
        ProbeDurationInstrument,
        unit: "s",
        description: "How long the projection store took to answer the gate probe.");

    static GateMetrics()
    {
        Meter.CreateObservableGauge(
            "pipeline.gate.open",
            Observe,
            unit: "1",
            description: "1 while the projection store is usable and consumers may run, 0 while it is not.");
    }

    /// <summary>
    /// Publishes <paramref name="isOpen"/> as a gauge until the returned token is disposed.
    /// </summary>
    /// <remarks>
    /// SEEDS THE TRIP COUNTER AT ZERO, and that is not incidental. A counter never incremented
    /// exports no series, so "this gate has never tripped" and "nothing is measuring this gate" were
    /// the same absence -- checked against Prometheus, the name existed from an earlier trip and
    /// carried no current samples, so a panel keyed to it drew nothing and said nothing. Registering
    /// a gate is exactly the moment its trip count becomes a meaningful zero.
    /// </remarks>
    public static IDisposable Register(Func<bool> isOpen)
    {
        ArgumentNullException.ThrowIfNull(isOpen);

        var token = new Registration();
        Gates[token] = isOpen;
        Trips.Add(0);
        return token;
    }

    /// <summary>
    /// Counts one trip. Callers pass the FALLING EDGE only: the gate raises on transitions in both
    /// directions, and counting both would make the number mean "changes" rather than "outages" --
    /// half of it would be the recoveries.
    /// </summary>
    public static void RecordTrip() => Trips.Add(1);

    /// <summary>
    /// Records one probe measurement.
    /// <para>
    /// <paramref name="outcome"/> is load-bearing, not decoration. A timed-out probe records the
    /// ceiling rather than the true duration -- the ping is abandoned, not cancelled -- so folded
    /// into an untagged histogram those would pin the p99 at exactly ProbeTimeout and invite a
    /// reader to believe it.
    /// </para>
    /// </summary>
    /// <param name="elapsed">Wall time from issuing the ping to learning its fate.</param>
    /// <param name="outcome">healthy, timeout, or failed.</param>
    public static void RecordProbe(TimeSpan elapsed, string outcome) =>
        ProbeDuration.Record(
            elapsed.TotalSeconds,
            new KeyValuePair<string, object?>("outcome", outcome));

    private static IEnumerable<Measurement<int>> Observe() =>
        Gates.Values.Select(open => new Measurement<int>(open() ? 1 : 0));

    private sealed class Registration : IDisposable
    {
        public void Dispose() => Gates.TryRemove(this, out _);
    }
}
