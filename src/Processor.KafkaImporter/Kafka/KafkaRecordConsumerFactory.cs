namespace Processor.KafkaImporter.Kafka;

/// <summary>The production factory. One line, so the cache in the processor is what gets tested.</summary>
public sealed class KafkaRecordConsumerFactory : IRecordConsumerFactory
{
    public IRecordConsumer Create(string brokerList, string consumerGroup)
        => new KafkaRecordConsumer(brokerList, consumerGroup);
}
