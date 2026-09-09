using BaseProcessor.Core.Configuration;

namespace Processor.KafkaImporter;

/// <summary>
/// The step payload, flat: four scalars and no nesting. The framework binds it case-insensitively
/// and ignores unknown properties, so <c>{"topic":"records","consumerGroup":"kafka-importer",
/// "messageCount":100,"idleTimeoutSeconds":5}</c> binds, and a fifth field added later does not
/// break workflows authored before it.
/// <para>
/// <b>There is no broker list here, and its absence is the shape of the payload.</b> Every field a
/// step names is one a workflow author chooses: which topic to read, which group to read it under,
/// how much to take and how long to wait. The broker is org infrastructure — outside this cluster,
/// owned by someone else, the same for every step this deployment will ever run — so it arrives from
/// configuration instead, as <c>Kafka__BrokerList</c>, beside the RabbitMQ and Redis addresses. See
/// <see cref="Kafka.KafkaBrokerOptions"/>.
/// </para>
/// <para>
/// It used to be here, and payloads written while it was still carry the key. Nothing rewrites those
/// rows: binding ignores what it does not know, so the leftover is inert rather than breaking, and
/// editing it changes nothing.
/// </para>
/// </summary>
public sealed record KafkaImporterConfig(
    string Topic,
    string ConsumerGroup,
    int MessageCount,
    int IdleTimeoutSeconds) : ImporterConfig(MessageCount, IdleTimeoutSeconds);
