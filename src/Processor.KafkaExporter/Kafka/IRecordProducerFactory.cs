namespace Processor.KafkaExporter.Kafka;

/// <summary>
/// Mints a producer for one delivery timeout. Separate from <see cref="IRecordProducer"/> so the
/// processor's cache can be tested by counting how many times this was called.
/// <para>
/// <b>No topic here, and that is the difference from the importer's factory.</b> A consumer is bound
/// to a group and subscribes to a topic, so its factory names the group; a producer is bound to
/// neither and names its topic per record. What a producer IS bound to at construction is the
/// delivery timeout — see <c>KafkaProducerSettings</c> — which is why that is the one thing this
/// takes.
/// </para>
/// <para>
/// <b>And no broker list</b>, which used to travel with it. An implementation holds the org's broker
/// from configuration, so a step payload cannot name one — see <see cref="KafkaBrokerOptions"/>.
/// </para>
/// </summary>
public interface IRecordProducerFactory
{
    IRecordProducer Create(TimeSpan deliveryTimeout);
}
