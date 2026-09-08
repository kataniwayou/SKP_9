namespace Processor.KafkaExporter.Kafka;

/// <summary>The production factory. One line, so the cache in the processor is what gets tested.</summary>
public sealed class KafkaRecordProducerFactory : IRecordProducerFactory
{
    public IRecordProducer Create(string brokerList, TimeSpan deliveryTimeout)
        => new KafkaRecordProducer(brokerList, deliveryTimeout);
}
