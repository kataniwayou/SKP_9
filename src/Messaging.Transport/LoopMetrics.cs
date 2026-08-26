using System.Diagnostics.Metrics;

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
    /// Iterations completed, by loop. <c>{iteration}</c> rather than <c>"1"</c>: a unit of
    /// <c>"1"</c> makes the Prometheus exporter append <c>_ratio</c>, which has already cost this
    /// repository one panel that matched nothing and rendered a confident green zero.
    /// </summary>
    private static readonly Counter<long> Iterations = Meter.CreateCounter<long>(
        IterationsInstrument,
        unit: "{iteration}",
        description: "Iterations completed by a named loop. Its rate is the loop's liveness.");

    /// <summary>
    /// Publishes <paramref name="loop"/> at zero.
    /// <para>
    /// <b>LOAD-BEARING, and not an optimisation.</b> A counter that has never been incremented
    /// exports no series at all, so a loop that failed to start produces no data -- and a panel
    /// comparing <c>rate()</c> against a threshold has nothing to compare. The exact failure the
    /// metric exists to catch would be the one it could not express.
    /// </para>
    /// </summary>
    public static void Seed(string loop) => Iterations.Add(0, Tag(loop));

    /// <summary>Records one completed iteration of <paramref name="loop"/>.</summary>
    public static void Count(string loop) => Iterations.Add(1, Tag(loop));

    private static KeyValuePair<string, object?> Tag(string loop)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(loop);
        return new KeyValuePair<string, object?>("loop", loop);
    }
}
