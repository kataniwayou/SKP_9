using System.Collections.Concurrent;
using System.Diagnostics.Metrics;
using Microsoft.Extensions.Hosting;

namespace BaseConsole.Core.Gating;

/// <summary>
/// Publishes the projection-store gate as metrics, without <see cref="L2Gate"/> knowing about it.
/// <para>
/// <b>A separate owner rather than instrumentation inside the gate, and that is a constraint.</b>
/// <see cref="L2Gate"/> is a deliberate copy of <c>BaseApi.Core.Gating.L2Gate</c>, and its own
/// remarks say behaviour must not diverge between the two. Instrumenting the console copy while
/// the API copy is out of scope would be exactly that divergence, so both stay untouched.
/// </para>
/// <para>
/// <b>It is an <see cref="IHostedService"/> only so the container constructs it.</b> A DI singleton
/// is never built until something resolves it, and an observable gauge that is never created
/// reports nothing — with no error anywhere to say so. Start and Stop do no work.
/// </para>
/// <para>
/// The subscription honours the gate's standing rule that handlers must not perform I/O and must
/// not re-enter it: incrementing a counter is a flag flip. The gauge does not use the event at all,
/// reading <see cref="L2Gate.IsOpen"/> when it is polled.
/// </para>
/// </summary>
internal sealed class L2GateMetrics : IHostedService, IDisposable
{
    /// <summary>
    /// Must match the string passed to <c>AddMeter</c> in <c>AddBaseConsoleObservability</c>. A
    /// constant rather than a literal in two places, because a typo produces no error and no
    /// metrics.
    /// </summary>
    internal const string MeterName = "BaseConsole.Core.Gating";

    private static readonly Meter Meter = new(MeterName);

    private static readonly Counter<long> Trips = Meter.CreateCounter<long>(
        "pipeline.gate.trips",
        unit: "1",
        description: "Times the projection store went away and consumption was paused at the broker.");

    /// <summary>
    /// Must match the name the view in <c>AddBaseConsoleObservability</c> targets. A view whose
    /// instrument name matches nothing is silently ignored, so a typo here costs the histogram its
    /// bucket boundaries and nothing reports the mistake.
    /// </summary>
    internal const string ProbeDurationInstrument = "pipeline.gate.probe.duration";

    /// <summary>
    /// How long the store took to answer the gate probe.
    /// <para>
    /// <b>The instrument the gate could not be a substitute for.</b> The gate answers "did the store
    /// reply inside <c>ProbeTimeout</c>", which is a yes/no. Measured on the live stack: Redis made
    /// 685x slower for the processor — 0.44 ms to 301 ms, verified with <c>redis-cli --latency</c> —
    /// moved nothing on any board, because a store a thousand times slower and still inside a 2 s
    /// budget is, to a yes/no, a healthy store. Past the budget it read as a full outage instead.
    /// Two states, working and gone, with nothing in between; this is what puts something in
    /// between.
    /// </para>
    /// <para>
    /// <b>Recorded from the probe rather than from real traffic</b> because the probe ticks on a
    /// fixed interval whether or not anything is flowing, so this reports during idle periods too.
    /// A histogram over real store calls would go quiet exactly when a pipeline has stalled, which
    /// is when the latency question is most worth asking.
    /// </para>
    /// </summary>
    private static readonly Histogram<double> ProbeDuration = Meter.CreateHistogram<double>(
        ProbeDurationInstrument,
        unit: "s",
        description: "How long the projection store took to answer the gate probe.");

    /// <summary>
    /// Records one probe measurement.
    /// <para>
    /// <b><paramref name="outcome"/> is load-bearing, not decoration.</b> A timed-out probe records
    /// the ceiling rather than the true duration — the ping is abandoned, not cancelled, so how long
    /// it would have taken is unknowable. Folded into an untagged histogram those would pin the p99
    /// at exactly <c>ProbeTimeout</c> and invite a reader to believe it. Tagged, a latency panel can
    /// exclude them and a separate count can carry them.
    /// </para>
    /// </summary>
    /// <param name="elapsed">Wall time from issuing the ping to learning its fate.</param>
    /// <param name="outcome">healthy, timeout, or failed.</param>
    internal static void RecordProbe(TimeSpan elapsed, string outcome) =>
        ProbeDuration.Record(
            elapsed.TotalSeconds,
            new KeyValuePair<string, object?>("outcome", outcome));

    /// <summary>
    /// Every live owner's gate, keyed by the owner itself.
    /// <para>
    /// <b>This registry exists so there is ONE observable instrument rather than one per owner.</b>
    /// Only one <see cref="L2GateMetrics"/> exists per process today, but the same duplicate-stream
    /// hazard that <c>IngressMetrics</c> documents for its consumer gauge applies to any observable
    /// created outside a static constructor: a second construction — as every test in this class
    /// performs, each with its own gate — would register a second callback on the same instrument
    /// name, and the OpenTelemetry SDK warns about and may drop the duplicate. Reading
    /// <see cref="L2Gate.IsOpen"/> through a registry keeps exactly one <c>CreateObservableGauge</c>
    /// call alive for the process's lifetime, with Dispose removing an owner's entry rather than
    /// tearing down the instrument — which cannot be done short of disposing the Meter itself.
    /// </para>
    /// </summary>
    private static readonly ConcurrentDictionary<L2GateMetrics, L2Gate> Live = new();

    static L2GateMetrics()
    {
        // Registered once, in the static constructor, because an observable created more than once
        // is the duplicate-stream hazard the registry above exists to avoid. The returned instrument
        // is intentionally not stored: the Meter owns it and the callback keeps it alive.
        Meter.CreateObservableGauge(
            "pipeline.gate.open",
            Observe,
            unit: "1",
            description: "1 while the projection store is usable and consumers may run, 0 while it is not.");
    }

    private readonly L2Gate _gate;

    public L2GateMetrics(L2Gate gate)
    {
        _gate = gate ?? throw new ArgumentNullException(nameof(gate));

        Live[this] = gate;
        _gate.StateChanged += OnStateChanged;
    }

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private static IEnumerable<Measurement<int>> Observe() =>
        Live.Select(entry => new Measurement<int>(entry.Value.IsOpen ? 1 : 0));

    /// <summary>
    /// The falling edge only. The gate raises this on transitions in both directions, and counting
    /// both would make the number mean "changes" rather than "outages" — half of it would be the
    /// recoveries.
    /// </summary>
    private void OnStateChanged(bool open)
    {
        if (!open)
        {
            Trips.Add(1);
        }
    }

    /// <summary>
    /// Unsubscribes AND leaves the registry, so a disposed owner is not merely stale in the next
    /// poll but genuinely absent from it — the counter and the gauge both stop reporting this gate.
    /// </summary>
    public void Dispose()
    {
        _gate.StateChanged -= OnStateChanged;
        Live.TryRemove(this, out _);
    }
}
