using System.Diagnostics;
using Confluent.Kafka;

namespace Processor.PathImporter.Kafka;

/// <summary>
/// The real client behind the seam. It translates and buffers, and holds no policy: every decision
/// about terminals, ordering and eviction is in <c>PathImporterProcessor</c>, where a fake can reach
/// it. This file is the part the hermetic suite cannot cover, so there is deliberately as little of
/// it as the seam allows.
/// </summary>
public sealed class KafkaPathConsumer : IPathConsumer
{
    private readonly IConsumer<Ignore, string> _inner;

    /// <summary>
    /// A record fetched by <see cref="WaitForAssignment"/> and not yet handed to the loop.
    /// <para>
    /// <b>Without this the wait would eat a path.</b> librdkafka assigns partitions only during a
    /// poll, so asking "am I assigned yet" means polling, and a poll can return a record. Dropping it
    /// would lose a path with nothing recording the loss — exactly the failure the commit ordering
    /// exists to prevent, reintroduced one layer down.
    /// </para>
    /// </summary>
    private ConsumeResult<Ignore, string>? _pending;

    /// <summary>
    /// The result <see cref="Consume"/> most recently handed to the loop as a <see cref="PathRecord"/>.
    /// This, not the <c>record</c> argument, is what <see cref="Commit"/> commits — see its comment.
    /// </summary>
    private ConsumeResult<Ignore, string>? _lastConsumed;

    public KafkaPathConsumer(string brokerList, string consumerGroup)
        => _inner = new ConsumerBuilder<Ignore, string>(
               KafkaConsumerSettings.For(brokerList, consumerGroup)).Build();

    public void Subscribe(string topic) => _inner.Subscribe(topic);

    public bool WaitForAssignment(TimeSpan timeout)
    {
        if (_inner.Assignment.Count > 0 || _pending is not null)
        {
            return true;
        }

        var clock = Stopwatch.StartNew();
        var slice = TimeSpan.FromMilliseconds(200);

        while (clock.Elapsed < timeout)
        {
            // A record arriving IS the assignment, and it must be kept — see _pending. An EOF marker
            // is neither: it is a control message, not a path, so it is discarded rather than
            // buffered, and the assignment check below still fires because reaching EOF on a
            // partition requires already being assigned one.
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

    public PathRecord? Consume(TimeSpan timeout)
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

        // An EOF marker is a control message, not a path: hand back nothing, and do not let it
        // become the result Commit acts on.
        if (result is null || result.IsPartitionEOF)
        {
            return null;
        }

        _lastConsumed = result;
        return new PathRecord(result.Message.Value, result.TopicPartitionOffset.ToString());
    }

    /// <summary>
    /// Commits <see cref="_lastConsumed"/>, not <paramref name="record"/> — the seam's
    /// <see cref="PathRecord"/> carries no Confluent type to commit with, so the adapter commits the
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
    /// The offset check below exists because the hermetic suite's fake commits the record it is
    /// <i>handed</i>, while this adapter commits the record it last <i>handed out</i>. Those are the
    /// same thing only while the loop consumes one record and commits it before consuming the next —
    /// and this is the one file no test can reach to catch the two contracts drifting apart, so the
    /// assertion has to live here instead.
    /// </para>
    /// </summary>
    public void Commit(PathRecord record)
    {
        ArgumentNullException.ThrowIfNull(record);

        if (_lastConsumed is null)
        {
            throw new InvalidOperationException(
                "KafkaPathConsumer.Commit was called before Consume returned a record; the loop " +
                "must consume each path before acknowledging it.");
        }

        if (record.Offset != _lastConsumed.TopicPartitionOffset.ToString())
        {
            throw new InvalidOperationException(
                $"KafkaPathConsumer.Commit was given {record.Offset} but the last record handed out was " +
                $"{_lastConsumed.TopicPartitionOffset}. This adapter commits the record it last returned, " +
                "so each path must be committed before the next is consumed.");
        }

        _inner.Commit(_lastConsumed);
    }

    public void Close() => _inner.Close();

    public void Dispose() => _inner.Dispose();
}
