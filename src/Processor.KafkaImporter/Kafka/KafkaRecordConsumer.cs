using System.Diagnostics;
using Confluent.Kafka;

namespace Processor.KafkaImporter.Kafka;

/// <summary>
/// The real client behind the seam. It translates and buffers, and holds no policy: every decision
/// about terminals, ordering and eviction is in <c>KafkaImporterProcessor</c>, where a fake can reach
/// it. This file is the part the hermetic suite cannot cover, so there is deliberately as little of
/// it as the seam allows.
/// </summary>
public sealed class KafkaRecordConsumer : IRecordConsumer
{
    private readonly IConsumer<Ignore, byte[]> _inner;

    /// <summary>
    /// A record fetched by <see cref="WaitForAssignment"/> and not yet handed to the loop.
    /// <para>
    /// <b>Without this the wait would eat a record.</b> librdkafka assigns partitions only during a
    /// poll, so asking "am I assigned yet" means polling, and a poll can return a record. Dropping it
    /// would lose that record with nothing recording the loss — exactly the failure the commit
    /// ordering exists to prevent, reintroduced one layer down.
    /// </para>
    /// </summary>
    private ConsumeResult<Ignore, byte[]>? _pending;

    /// <summary>
    /// The result <see cref="Consume"/> most recently handed to the loop as a <see cref="KafkaRecord"/>.
    /// This, not the <c>record</c> argument, is what <see cref="Commit"/> commits — see its comment.
    /// </summary>
    private ConsumeResult<Ignore, byte[]>? _lastConsumed;

    public KafkaRecordConsumer(string brokerList, string consumerGroup)
        => _inner = new ConsumerBuilder<Ignore, byte[]>(
               KafkaConsumerSettings.For(brokerList, consumerGroup)).Build();

    public void Subscribe(string topic) => _inner.Subscribe(topic);

    public bool WaitForAssignment(TimeSpan timeout)
    {
        // A record already in hand is proof of both things at once: assigned, and the broker answered
        // recently enough to hand it over. Nothing to verify.
        if (_pending is not null)
        {
            return true;
        }

        // AN ASSIGNMENT IS LOCAL STATE AND LOCAL STATE OUTLIVES THE BROKER. librdkafka keeps the
        // partition list it was last given until it decides to revoke it, which needs coordinator
        // contact or a session timeout, so a consumer whose broker vanished a moment ago still
        // answers "assigned" here. Returning true on that alone sends the dispatch into the loop,
        // where Consume finds nothing to read and the dispatch reports 0/N Drained -- a healthy
        // terminal, and indistinguishable from an empty topic.
        //
        // So the cached assignment is treated as a claim to be checked rather than an answer.
        // QueryWatermarkOffsets is a round trip to the partition leader: it returns in single-digit
        // milliseconds against a live broker and throws against an absent one, which part one turns
        // into the failed step the orchestrator sees. Measured before this existed: a warm consumer
        // claimed its assignment for two dispatches after the broker stopped at the 45s session
        // timeout, and for one at 10s.
        if (_inner.Assignment.Count > 0)
        {
            _inner.QueryWatermarkOffsets(_inner.Assignment[0], timeout);
            return true;
        }

        var clock = Stopwatch.StartNew();
        var slice = TimeSpan.FromMilliseconds(200);

        while (clock.Elapsed < timeout)
        {
            // A record arriving IS the assignment, and it must be kept — see _pending. An EOF marker
            // would be neither: it is a control message, not a record value, so it would be discarded rather
            // than buffered, and the assignment check below would still fire because reaching EOF on
            // a partition requires already being assigned one.
            //
            // Defensive and currently unreachable: KafkaConsumerSettings.For never sets
            // EnablePartitionEof, which defaults to false, so librdkafka never emits this marker and
            // IsPartitionEOF is never true here. Kept in case that setting is ever turned on -- cheap
            // insurance against a live EOF being mistaken for a record.
            var result = _inner.Consume(slice);
            if (result is not null && !result.IsPartitionEOF)
            {
                _pending = result;
                return true;
            }

            if (_inner.Assignment.Count > 0)
            {
                return true;
            }
        }

        return _inner.Assignment.Count > 0;
    }

    public KafkaRecord? Consume(TimeSpan timeout)
    {
        var result = _pending;
        if (result is not null)
        {
            _pending = null;
        }
        else
        {
            result = _inner.Consume(timeout);
        }

        // An EOF marker would be a control message, not a record: hand back nothing, and do not let it
        // become the result Commit acts on.
        //
        // Defensive and currently unreachable, for the same reason as the branch in
        // WaitForAssignment above: EnablePartitionEof is never set by KafkaConsumerSettings.For, so
        // it defaults to false and IsPartitionEOF can never be true here. Kept as cheap insurance
        // against that setting being enabled later.
        if (result is null || result.IsPartitionEOF)
        {
            return null;
        }

        _lastConsumed = result;
        return new KafkaRecord(result.Message.Value, result.TopicPartitionOffset.ToString());
    }

    /// <summary>
    /// Commits <see cref="_lastConsumed"/>, not <paramref name="record"/> — the seam's
    /// <see cref="KafkaRecord"/> carries no Confluent type to commit with, so the adapter commits the
    /// Confluent result it kept from the matching <see cref="Consume"/> instead.
    /// <para>
    /// This is not the offset-less <c>Commit()</c> overload. That one commits whatever was passed to
    /// <c>StoreOffset</c>, and nothing here ever calls it — <c>EnableAutoOffsetStore</c> is off, on
    /// purpose, so an offset-less commit would be a silent no-op or throw <c>Local_NoOffset</c>, and
    /// the send-then-ACK ordering the design rests on would never reach the broker. Committing the
    /// named result also closes a second hole an offset-less or position-based commit would leave
    /// open: a record parked in <see cref="_pending"/> is never handed out by <see cref="Consume"/>,
    /// so it never becomes <see cref="_lastConsumed"/> either, and cannot be acknowledged before its
    /// branch is sent.
    /// </para>
    /// <para>
    /// The offset check below and <c>FakeRecordConsumer.Commit</c>'s own check enforce the identical
    /// rule, deliberately: each refuses any record but the one its own <c>Consume</c> last handed
    /// out. That symmetry is the point — a loop that batched commits, or committed a stale record,
    /// now fails the same way in the hermetic suite as it would against a real broker, instead of
    /// passing every fake-backed fact and only failing later. The fake is in fact the stricter of the
    /// two: it compares the whole <see cref="KafkaRecord"/>, this adapter only <c>Offset</c>, since a
    /// <see cref="TopicPartitionOffset"/> is what it has to commit with.
    /// </para>
    /// </summary>
    public void Commit(KafkaRecord record)
    {
        ArgumentNullException.ThrowIfNull(record);

        if (_lastConsumed is null)
        {
            throw new InvalidOperationException(
                "KafkaRecordConsumer.Commit was called before Consume returned a record; the loop " +
                "must consume each record before acknowledging it.");
        }

        if (record.Offset != _lastConsumed.TopicPartitionOffset.ToString())
        {
            throw new InvalidOperationException(
                $"KafkaRecordConsumer.Commit was given {record.Offset} but the last record handed out was " +
                $"{_lastConsumed.TopicPartitionOffset}. This adapter commits the record it last returned, " +
                "so each record must be committed before the next is consumed.");
        }

        _inner.Commit(_lastConsumed);
    }

    public void Close() => _inner.Close();

    public void Dispose() => _inner.Dispose();
}
