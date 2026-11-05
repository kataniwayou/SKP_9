using BaseProcessor.Core.Configuration;

namespace Processor.KafkaImporter;

/// <summary>
/// The step payload, flat: five scalars and no nesting. The framework binds it case-insensitively
/// and ignores unknown properties, so <c>{"topic":"records","consumerGroup":"kafka-importer",
/// "minMessageCount":1,"maxMessageCount":100,"idleTimeoutSeconds":5}</c> binds, and a field added
/// later does not break workflows authored before it.
/// <para>
/// <b>The two counts are a ceiling and a floor on what one dispatch sends.</b>
/// <c>maxMessageCount</c> bounds the records read. <c>minMessageCount</c> is how many must be sent for
/// the dispatch to count as an import; fewer is reported Cancelled, on the same path as an empty
/// topic. It is a report, not a hold: each record is sent and committed before the next is read, so
/// the branches a short dispatch did send carry on. Left out it is 1 — the behaviour every payload
/// authored before it had. It is last only because a positional default must be.
/// </para>
/// <para>
/// <c>maxMessageCount</c> was <c>messageCount</c> until 2026-11-05. Unlike the broker list below, the
/// stored payloads were rewritten when it was renamed: a leftover <c>messageCount</c> binds nothing,
/// so the ceiling would be 0 and the step would fail.
/// </para>
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
    int MaxMessageCount,
    int IdleTimeoutSeconds,
    int MinMessageCount = 1) : ProcessorConfig;
