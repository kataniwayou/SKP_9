using BaseProcessor.Core.Configuration;

namespace Processor.KafkaImporter;

/// <summary>
/// The step payload, flat: five scalars and no nesting. The framework binds it case-insensitively
/// and ignores unknown properties, so <c>{"brokerList":"kafka:9092","topic":"records",
/// "consumerGroup":"kafka-importer","messageCount":100,"idleTimeoutSeconds":5}</c> binds, and a sixth
/// field added later does not break workflows authored before it.
/// <para>
/// <b>The broker list travels in the payload rather than in configuration.</b> Brokers are usually
/// infrastructure and infrastructure usually comes from the environment, so this is the one field
/// whose placement is arguable. Keeping it here lets one deployment serve several topics on several
/// clusters without a redeploy, and it keeps every field of this record answering the same question
/// the same way. If that ever inverts it is one field and a fallback.
/// </para>
/// </summary>
public sealed record KafkaImporterConfig(
    string BrokerList,
    string Topic,
    string ConsumerGroup,
    int MessageCount,
    int IdleTimeoutSeconds) : ImporterConfig(MessageCount, IdleTimeoutSeconds);
