namespace BaseApi.Core.Gating;

/// <summary>
/// The timestamp a long-running loop stamps on every iteration, and the only evidence anything has
/// that the loop is still running.
/// <para>
/// <b>This measures iteration, not success.</b> A loop that probed the store and found it down has
/// completed a perfectly good iteration — it observed a fact and acted on it. Conflating the two
/// would make an outage in a dependency look like a failure of the process observing it, and the
/// process would be restarted precisely when its continued running matters most.
/// </para>
/// </summary>
public interface ILoopHeartbeat
{
    /// <summary>The last stamp, or null if the loop has never run an iteration.</summary>
    DateTimeOffset? Last { get; }

    /// <summary>Stamp the current time. Called at the top of every iteration, before any I/O.</summary>
    void Beat();
}
