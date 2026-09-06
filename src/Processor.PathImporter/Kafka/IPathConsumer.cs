namespace Processor.PathImporter.Kafka;

/// <summary>
/// Everything the loop knows about Kafka, which is four verbs. The narrowness is the point: it is
/// what lets every terminal, ordering and cache rule be tested against a fake, with no broker
/// anywhere in the hermetic suite.
/// </summary>
public interface IPathConsumer : IDisposable
{
    /// <summary>Non-blocking, as librdkafka's is. Assignment follows later, on a poll.</summary>
    void Subscribe(string topic);

    /// <summary>
    /// Blocks until the group has assigned this consumer a partition, or the timeout elapses.
    /// <para>
    /// <b>This exists to stop an unassigned consumer being read as an empty topic.</b> A poll during
    /// the group join returns nothing, which is indistinguishable from a drained partition unless
    /// somebody asks this question first — and the join is exactly where the broker's
    /// three-second initial rebalance delay lands.
    /// </para>
    /// </summary>
    /// <returns>True when a partition is assigned.</returns>
    bool WaitForAssignment(TimeSpan timeout);

    /// <summary>Null when no record arrived within <paramref name="timeout"/>.</summary>
    PathRecord? Consume(TimeSpan timeout);

    /// <summary>Commits through <paramref name="record"/>. The ACK.</summary>
    void Commit(PathRecord record);

    /// <summary>Leaves the group deliberately, rather than by session timeout.</summary>
    void Close();
}
