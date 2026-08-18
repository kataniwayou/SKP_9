namespace BaseApi.Core.Gating;

/// <summary>
/// Timing for the probe loop and the liveness window derived from it.
/// <para>
/// <b>The three values are one budget, not three independent knobs.</b> The staleness window is
/// <see cref="Interval"/> × <see cref="StaleFactor"/>, and the worst-case gap between two stamps is
/// <see cref="Interval"/> plus however long one iteration's bounded work takes. If that gap ever
/// reaches the window, a loop that is running perfectly well is reported dead and the process is
/// restarted mid-outage — killing the component whose entire job is surviving it. Changing any one
/// value means re-deriving the others.
/// </para>
/// <para>
/// At the defaults: a 15s window against a worst case of 5s of delay plus roughly 2s of bounded
/// probing, leaving several seconds of margin. That margin is what pays for adding work to an
/// iteration; adding unbounded work spends it all at once.
/// </para>
/// </summary>
public sealed class L2GateOptions
{
    /// <summary>Delay between iterations. Also the floor on how quickly a recovery is noticed.</summary>
    public TimeSpan Interval { get; set; } = TimeSpan.FromSeconds(5);

    /// <summary>
    /// How long a single measurement may take before it is abandoned and treated as a failure. This
    /// bound exists because the client's own timeouts are far longer than one iteration, so a wedged
    /// store would otherwise stall the loop past its staleness window.
    /// </summary>
    public TimeSpan ProbeTimeout { get; set; } = TimeSpan.FromSeconds(2);

    /// <summary>
    /// Consecutive successful measurements required before the gate opens. One success proves a
    /// socket answered; requiring a run of them costs a few seconds and removes most flapping.
    /// </summary>
    public int HealthyChecksToOpen { get; set; } = 2;

    /// <summary>
    /// Multiplier applied to <see cref="Interval"/> to give the staleness window used by the liveness
    /// check. Three leaves room for one slow iteration without reporting a healthy loop as dead.
    /// </summary>
    public int StaleFactor { get; set; } = 3;
}
