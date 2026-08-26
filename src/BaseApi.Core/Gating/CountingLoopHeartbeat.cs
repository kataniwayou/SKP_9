using Messaging.Transport;

namespace BaseApi.Core.Gating;

/// <summary>
/// Wraps an <see cref="ILoopHeartbeat"/> so the loop reports <c>pipeline.loop.iterations</c> as well
/// as stamping the holder a liveness check reads.
/// <para>
/// <b>A copy of <c>BaseConsole.Core.Loop.CountingLoopHeartbeat</c>, and it has to be.</b> This
/// assembly carries its own <see cref="ILoopHeartbeat"/> — a two-member interface against the console
/// base's four — and the two libraries do not reference each other. What is NOT duplicated is the
/// instrument: both wrappers forward to <see cref="LoopMetrics"/> in the transport, so one counter
/// serves every loop in the stack and the <c>loop</c> label means the same thing on every board.
/// </para>
/// <para>
/// Registering a heartbeat without this wrapper is the visible omission: the loop still beats, the
/// liveness check still passes, and no panel can draw its cadence. Both other hosts shipped that way
/// once.
/// </para>
/// </summary>
public sealed class CountingLoopHeartbeat : ILoopHeartbeat
{
    private readonly ILoopHeartbeat _inner;
    private readonly string _loop;

    /// <param name="inner">The holder whose stamp the readiness check reads.</param>
    /// <param name="loop">
    /// The loop's key, matching the name its liveness check uses, so a rate panel and a failing probe
    /// name the same thing.
    /// </param>
    public CountingLoopHeartbeat(ILoopHeartbeat inner, string loop)
    {
        _inner = inner ?? throw new ArgumentNullException(nameof(inner));
        ArgumentException.ThrowIfNullOrWhiteSpace(loop);

        _loop = loop;

        // SEEDED, AND THIS LINE IS LOAD-BEARING -- see LoopMetrics.Seed. A loop that never starts
        // has to read as a flat zero rather than as no data, or the failure the metric exists to
        // catch is the one it cannot express.
        LoopMetrics.Seed(loop);
    }

    /// <inheritdoc/>
    public DateTimeOffset? Last => _inner.Last;

    /// <inheritdoc/>
    public void Beat()
    {
        // Counted before delegating, so the count and the stamp cannot disagree about whether an
        // iteration happened.
        LoopMetrics.Count(_loop);
        _inner.Beat();
    }
}
