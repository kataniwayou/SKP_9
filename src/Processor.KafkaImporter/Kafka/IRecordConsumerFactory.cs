namespace Processor.KafkaImporter.Kafka;

/// <summary>
/// Mints a consumer for one broker list and group. Separate from <see cref="IRecordConsumer"/> so the
/// processor's cache can be tested by counting how many times this was called.
/// </summary>
public interface IRecordConsumerFactory
{
    IRecordConsumer Create(string brokerList, string consumerGroup);
}
