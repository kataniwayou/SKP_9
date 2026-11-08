namespace Processor.KafkaImporter.Kafka;

/// <summary>
/// Everything the loop knows about Kafka, which is four verbs. The narrowness is the point: it is
/// what lets every terminal, ordering and cache rule be tested against a fake, with no broker
/// anywhere in the hermetic suite.
/// </summary>
public interface IRecordConsumer : IDisposable
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

    /// <summary>
    /// The records waiting for this group on the partitions assigned to this consumer: each one's high
    /// watermark less its committed offset, summed. Asked after <see cref="WaitForAssignment"/>.
    /// <para>
    /// <b>An upper bound.</b> Compaction gaps and transaction markers take offsets and are not records,
    /// so fewer may be read than this reports; never more, because a record produced after the count
    /// lies beyond the watermark it was taken at. It covers only this consumer's partitions.
    /// </para>
    /// <para>Throws against an absent broker, as the assignment check does.</para>
    /// </summary>
    long Backlog(TimeSpan timeout);

    /// <summary>Null when no record arrived within <paramref name="timeout"/>.</summary>
    KafkaRecord? Consume(TimeSpan timeout);

    /// <summary>
    /// Commits through <paramref name="record"/>. The ACK.
    /// <para>
    /// <b>The contract, binding on every implementation:</b> <paramref name="record"/> must be the
    /// same one the most recent call to <see cref="Consume"/> returned, and commits may not be
    /// batched — each record is committed before the next is consumed. Both
    /// <c>KafkaRecordConsumer</c> and the hermetic suite's fake enforce this identically, refusing
    /// anything else, so a loop that violated it would fail the same way against either. A third
    /// implementation must enforce it too, or that guarantee stops being one.
    /// </para>
    /// </summary>
    void Commit(KafkaRecord record);

    /// <summary>Leaves the group deliberately, rather than by session timeout.</summary>
    void Close();
}
