namespace Processor.PathImporter.Kafka;

/// <summary>The production factory. One line, so the cache in the processor is what gets tested.</summary>
public sealed class KafkaPathConsumerFactory : IPathConsumerFactory
{
    public IPathConsumer Create(string brokerList, string consumerGroup)
        => new KafkaPathConsumer(brokerList, consumerGroup);
}
