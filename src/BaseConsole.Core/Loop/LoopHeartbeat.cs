namespace BaseConsole.Core.Loop;

public sealed class LoopHeartbeat : ILoopHeartbeat
{
    private readonly TimeProvider _clock;
    private long _lastUtcTicks;

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

    public void Beat()
    {
        var now = _clock.GetUtcNow();
        Interlocked.Exchange(ref _lastUtcTicks, now.UtcTicks);
    }
}
