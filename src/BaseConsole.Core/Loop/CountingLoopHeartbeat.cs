using System.Diagnostics.Metrics;

namespace BaseConsole.Core.Loop;

/// <summary>
/// An <see cref="ILoopHeartbeat"/> that also counts iterations, so one registration gives a loop
/// both of its signals.
/// <para>
/// <b>A decorator rather than instrumentation inside <see cref="LoopHeartbeat"/>, and that is a
/// constraint rather than a preference.</b> <c>LoopHeartbeat</c> is one of the paired API/console
/// copies this repository requires not to diverge -- the same rule that forces <c>L2GateMetrics</c>
/// to instrument the gate from outside. Wrapping leaves both copies untouched.
/// </para>
/// <para>
/// <b>The two signals answer different questions and neither replaces the other.</b> The stamp
/// feeds <c>LoopLivenessHealthCheck</c>, which restarts the pod and is invisible on any board. The
/// count feeds a rate, which is visible on a board and shows a loop running SLOW before it is
/// declared dead -- at a 5s cadence a stale window is binary at 15s, while the rate reads 0.12
/// instead of 0.2.
/// </para>
/// </summary>
public sealed class CountingLoopHeartbeat : ILoopHeartbeat
{
    /// <summary>
    /// Must match the string passed to <c>AddMeter</c> in <c>AddBaseConsoleObservability</c>. A
    /// constant rather than a literal in two places, because a typo produces no error and no
    /// metrics.
    /// </summary>
    public const string MeterName = "BaseConsole.Core.Loop";

    public const string IterationsInstrument = "pipeline.loop.iterations";

    private static readonly Meter Meter = new(MeterName);

    /// <summary>
    /// Iterations completed, by loop. <c>{iteration}</c> rather than <c>"1"</c>: a unit of
    /// <c>"1"</c> makes the Prometheus exporter append <c>_ratio</c>, which has already cost this
    /// repository one panel that matched nothing and rendered a confident green zero.
    /// </summary>
    private static readonly Counter<long> Iterations = Meter.CreateCounter<long>(
        IterationsInstrument,
        unit: "{iteration}",
        description: "Iterations completed by a named loop. Its rate is the loop's liveness.");

    private readonly ILoopHeartbeat _inner;
    private readonly KeyValuePair<string, object?> _loop;

    /// <param name="loop">
    /// The loop's key, matching the one its keyed <see cref="ILoopHeartbeat"/> registration and its
    /// <c>LoopLivenessHealthCheck</c> already use, so a rate panel and a failing probe name the same
    /// thing.
    /// </param>
    public CountingLoopHeartbeat(ILoopHeartbeat inner, string loop)
    {
        _inner = inner ?? throw new ArgumentNullException(nameof(inner));
        ArgumentException.ThrowIfNullOrWhiteSpace(loop);

        _loop = new KeyValuePair<string, object?>("loop", loop);

        // SEEDED, AND THIS LINE IS LOAD-BEARING. A counter that has never been incremented
        // exports no series at all, so a loop that failed to start produces no data -- and a
        // panel comparing rate() against a threshold has nothing to compare. The exact failure
        // the metric exists to catch would be the one it could not express.
        Iterations.Add(0, _loop);
    }

    /// <inheritdoc/>
    public DateTimeOffset? Last => _inner.Last;

    /// <inheritdoc/>
    public bool IsRetired => _inner.IsRetired;

    /// <inheritdoc/>
    public void Beat()
    {
        // Counted before delegating, so the count and the stamp cannot disagree about whether an
        // iteration happened. Both must land before any I/O -- see ILoopHeartbeat.Beat.
        Iterations.Add(1, _loop);
        _inner.Beat();
    }

    /// <inheritdoc/>
    public void Retire() => _inner.Retire();
}
