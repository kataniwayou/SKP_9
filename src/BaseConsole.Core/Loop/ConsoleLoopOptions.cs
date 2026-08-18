namespace BaseConsole.Core.Loop;

public sealed class ConsoleLoopOptions
{
    /// <summary>Cadence of the discovery/liveness loop.</summary>
    public TimeSpan Interval { get; set; } = TimeSpan.FromSeconds(10);

    /// <summary>Multiples of <see cref="Interval"/> before a missing beat reads as dead.</summary>
    public int StaleFactor { get; set; } = 3;

    /// <summary>
    /// Cushion between the reply queue's consume confirmation and the first ask. The broker's
    /// confirmation is the guarantee; this only absorbs jitter, so zero must remain correct.
    /// </summary>
    public TimeSpan GracePeriod { get; set; } = TimeSpan.FromSeconds(1);
}
