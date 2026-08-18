using Microsoft.Extensions.Logging;

namespace BaseApi.Core.Gating;

/// <summary>
/// The shared heartbeat holder: written by the loop, read by the liveness check on a different
/// thread.
/// <para>
/// The backing field is a tick count rather than a <see cref="DateTimeOffset"/> because a struct
/// wider than a machine word can tear across threads — a reader could observe a value that was never
/// written. A 64-bit integer written with <see cref="Interlocked"/> cannot.
/// </para>
/// </summary>
public sealed class LoopHeartbeat : ILoopHeartbeat
{
    private readonly TimeProvider _clock;
    private readonly ILogger<LoopHeartbeat> _logger;

    // 0 means "never beaten", which is distinguishable from any real stamp and is the state the
    // liveness check reports as a loop that failed before its first iteration.
    private long _lastUtcTicks;

    public LoopHeartbeat(TimeProvider clock, ILogger<LoopHeartbeat> logger)
    {
        _clock  = clock ?? throw new ArgumentNullException(nameof(clock));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public DateTimeOffset? Last
    {
        get
        {
            var ticks = Interlocked.Read(ref _lastUtcTicks);
            return ticks == 0 ? null : new DateTimeOffset(ticks, TimeSpan.Zero);
        }
    }

    public void Beat()
    {
        var now = _clock.GetUtcNow();
        Interlocked.Exchange(ref _lastUtcTicks, now.UtcTicks);
    }
}
