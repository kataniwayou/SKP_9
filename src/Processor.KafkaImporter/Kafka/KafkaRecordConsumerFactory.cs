namespace Processor.KafkaImporter.Kafka;

/// <summary>The production factory. One line, so the cache in the processor is what gets tested.</summary>
public sealed class KafkaRecordConsumerFactory(KafkaBrokerOptions broker) : IRecordConsumerFactory
{
    public IRecordConsumer Create(string consumerGroup)
        => new KafkaRecordConsumer(broker.BrokerList, consumerGroup);
}
