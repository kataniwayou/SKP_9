using Confluent.Kafka;

namespace Processor.KafkaExporter.Kafka;

/// <summary>
/// The real client behind the seam. It translates and waits, and holds no policy: every decision
/// about outcomes, caching and eviction is in <c>KafkaExporterProcessor</c>, where a fake can reach
/// it. This file is the part the hermetic suite cannot cover, so there is deliberately as little of
/// it as the seam allows.
/// </summary>
public sealed class KafkaRecordProducer : IRecordProducer
{
    private readonly IProducer<Null, byte[]> _inner;

    public KafkaRecordProducer(string brokerList, TimeSpan deliveryTimeout)
        => _inner = new ProducerBuilder<Null, byte[]>(
               KafkaProducerSettings.For(brokerList, deliveryTimeout)).Build();

    /// <summary>
    /// <c>ProduceAsync</c>, not the callback-based <c>Produce</c>. The callback overload returns as
    /// soon as the record is in librdkafka's queue and reports delivery later on its own thread,
    /// which is the shape a step cannot use: the outcome it must report is exactly the thing that
    /// arrives after it would have returned.
    /// <para>
    /// <b>The status check is not redundant with the exception.</b> <c>ProduceAsync</c> throws on a
    /// rejection or a timeout, but a delivery report can also come back
    /// <see cref="PersistenceStatus.PossiblyPersisted"/> — the client sent the record and never
    /// learned what became of it, typically a connection lost mid-flight. Treating that as success
    /// would report an export that may not exist; treating it as failure risks a duplicate on a
    /// retry, and a duplicate is the recoverable direction. Both outcomes are the same
    /// <see cref="KafkaException"/> to the step above, which has two answers and no use for a third.
    /// </para>
    /// <para>
    /// A null key, so records round-robin across partitions. This processor exports whatever it was
    /// handed and has no notion of what in that payload would make a partitioning key — choosing one
    /// would be choosing an ordering guarantee on the author's behalf, and getting it wrong is worse
    /// than not offering it. If ordering ever matters, the key belongs in the step payload.
    /// </para>
    /// </summary>
    public async Task<string> ProduceAsync(string topic, byte[] value, CancellationToken ct)
    {
        var result = await _inner
            .ProduceAsync(topic, new Message<Null, byte[]> { Value = value }, ct)
            .ConfigureAwait(false);

        if (result.Status != PersistenceStatus.Persisted)
        {
            throw new KafkaException(new Error(
                ErrorCode.Local_Fail,
                $"the broker did not confirm the record as persisted: {result.Status}"));
        }

        return result.TopicPartitionOffset.ToString();
    }

    /// <summary>
    /// Flushes before disposing, because <c>Dispose</c> alone does not: librdkafka discards whatever
    /// is still queued. Nothing here should ever be queued — <see cref="ProduceAsync"/> is awaited to
    /// its delivery report and the step produces one record at a time — so this is insurance against
    /// a future caller that produces without waiting, not a live concern. The timeout is small for
    /// the same reason: there is nothing to wait for, and a shutdown must not hang on a broker that
    /// is already gone.
    /// </summary>
    public void Dispose()
    {
        try
        {
            _inner.Flush(TimeSpan.FromSeconds(5));
        }
        catch (ObjectDisposedException)
        {
            // Already gone. The only thing this method was going to do is throw the handle away.
        }

        _inner.Dispose();
    }
}
