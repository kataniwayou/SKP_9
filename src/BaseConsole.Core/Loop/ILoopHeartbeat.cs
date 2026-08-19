namespace BaseConsole.Core.Loop;

/// <summary>
/// The stamp a loop leaves on every iteration. It is the only evidence the process is still capable
/// of running that loop — a loop that is asleep is indistinguishable from one that has died.
/// <para>
/// <b>One holder per loop.</b> A holder shared between two loops is worse than none: the faster
/// loop's beat refreshes the stamp for both, so a dead loop stays invisible for as long as any
/// sibling still ticks. Register these keyed, one per loop, each with its own check and window.
/// </para>
/// </summary>
public interface ILoopHeartbeat
{
    /// <summary>The last stamp, or null if the loop has never run an iteration.</summary>
    DateTimeOffset? Last { get; }

    /// <summary>
    /// True once the loop has finished its work for good. A startup loop stops beating when it
    /// completes, which is indistinguishable from wedging unless it says so — without this, a
    /// finished loop reports stale one window later and restarts a healthy process.
    /// </summary>
    bool IsRetired { get; }

    /// <summary>Stamp the current time. Called at the top of every iteration, before any I/O.</summary>
    void Beat();

    /// <summary>
    /// Mark the loop complete, after its final beat. One-way and idempotent: a loop that has finished
    /// cannot un-finish, and nothing about it is worth watching afterwards.
    /// </summary>
    void Retire();
}
