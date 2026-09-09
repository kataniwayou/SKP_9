namespace Processor.KafkaImporter.Kafka;

/// <summary>
/// Mints a consumer for one group. Separate from <see cref="IRecordConsumer"/> so the processor's
/// cache can be tested by counting how many times this was called.
/// <para>
/// <b>The group, and not the broker.</b> An implementation holds the org's broker from
/// configuration, which is what makes it impossible for a step payload to name one — see
/// <see cref="KafkaBrokerOptions"/>.
/// </para>
/// </summary>
public interface IRecordConsumerFactory
{
    IRecordConsumer Create(string consumerGroup);
}
