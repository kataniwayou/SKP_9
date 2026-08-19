namespace BaseConsole.Core.Loop;

/// <summary>
/// The shared heartbeat holder: written by its loop, read by the liveness check on another thread.
/// <para>
/// The backing field is a tick count rather than a <see cref="DateTimeOffset"/> because a struct
/// wider than a machine word can tear across threads — a reader could observe a value that was never
/// written. A 64-bit integer written with <see cref="Interlocked"/> cannot.
/// </para>
/// </summary>
public sealed class LoopHeartbeat : ILoopHeartbeat
{
    private readonly TimeProvider _clock;

    // 0 means "never beaten", distinguishable from any real stamp.
    private long _lastUtcTicks;
    private int _isRetired; // 0 = false, 1 = true — Interlocked.Exchange has no bool overload

    public LoopHeartbeat(TimeProvider clock)
        => _clock = clock ?? throw new ArgumentNullException(nameof(clock));

    public DateTimeOffset? Last
    {
        get
        {
            var ticks = Interlocked.Read(ref _lastUtcTicks);
            return ticks == 0 ? null : new DateTimeOffset(ticks, TimeSpan.Zero);
        }
    }

    public bool IsRetired => Volatile.Read(ref _isRetired) == 1;

    public void Beat()
    {
        var now = _clock.GetUtcNow();
        Interlocked.Exchange(ref _lastUtcTicks, now.UtcTicks);
    }

    public void Retire() => Interlocked.Exchange(ref _isRetired, 1);
}
