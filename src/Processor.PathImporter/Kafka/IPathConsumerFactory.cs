namespace Processor.PathImporter.Kafka;

/// <summary>
/// Mints a consumer for one broker list and group. Separate from <see cref="IPathConsumer"/> so the
/// processor's cache can be tested by counting how many times this was called.
/// </summary>
public interface IPathConsumerFactory
{
    IPathConsumer Create(string brokerList, string consumerGroup);
}
