namespace BaseConsole.Core.Loop;

/// <summary>
/// The stamp a loop leaves on every iteration. It is the only evidence the process is still capable
/// of running that loop — a loop that is asleep is indistinguishable from one that has died.
/// </summary>
public interface ILoopHeartbeat
{
    /// <summary>The last stamp, or null if the loop has never run an iteration.</summary>
    DateTimeOffset? Last { get; }

    /// <summary>Stamp the current time. Called at the top of every iteration, before any I/O.</summary>
    void Beat();
}
