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

        var deadline = DateTime.UtcNow + timeout;
        var slice = TimeSpan.FromMilliseconds(200);

        while (DateTime.UtcNow < deadline)
        {
            // A record arriving IS the assignment, and it must be kept — see _pending.
            var result = _inner.Consume(slice);
            if (result is not null)
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

        return result is null
            ? null
            : new PathRecord(result.Message.Value, result.TopicPartitionOffset.ToString());
    }

    /// <summary>
    /// Commits by position rather than by the record handed back, because the seam's
    /// <see cref="PathRecord"/> carries no Confluent type to commit with. Safe only because the loop
    /// commits the record it has just consumed, in order, one at a time — which it does, and which
    /// is the ordering the whole design rests on.
    /// </summary>
    public void Commit(PathRecord record)
    {
        ArgumentNullException.ThrowIfNull(record);
        _inner.Commit();
    }

    public void Close() => _inner.Close();

    public void Dispose() => _inner.Dispose();
}
