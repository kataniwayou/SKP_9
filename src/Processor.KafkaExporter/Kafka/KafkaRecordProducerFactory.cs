namespace Processor.KafkaExporter.Kafka;

/// <summary>The production factory. One line, so the cache in the processor is what gets tested.</summary>
public sealed class KafkaRecordProducerFactory(KafkaBrokerOptions broker) : IRecordProducerFactory
{
    public IRecordProducer Create(TimeSpan deliveryTimeout)
        => new KafkaRecordProducer(broker.BrokerList, deliveryTimeout);
}
