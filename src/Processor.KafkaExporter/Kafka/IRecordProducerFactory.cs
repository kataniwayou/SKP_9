namespace Processor.KafkaExporter.Kafka;

/// <summary>
/// Mints a producer for one broker list and delivery timeout. Separate from
/// <see cref="IRecordProducer"/> so the processor's cache can be tested by counting how many times
/// this was called.
/// <para>
/// <b>No topic here, and that is the difference from the importer's factory.</b> A consumer is bound
/// to a group and subscribes to a topic, so its cache key carries all three; a producer is bound to
/// neither and names its topic per record. What a producer IS bound to at construction is the
/// delivery timeout — see <c>KafkaProducerSettings</c> — which is why that travels with the broker
/// list instead.
/// </para>
/// </summary>
public interface IRecordProducerFactory
{
    IRecordProducer Create(string brokerList, TimeSpan deliveryTimeout);
}
