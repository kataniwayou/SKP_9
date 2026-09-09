using BaseProcessor.Core.Configuration;

namespace Processor.KafkaExporter;

/// <summary>
/// The step payload, flat: two scalars and no nesting. The framework binds it case-insensitively
/// and ignores unknown properties, so <c>{"topic":"records","deliveryTimeoutSeconds":30}</c> binds,
/// and a third field added later does not break workflows authored before it.
/// <para>
/// <b>There is no broker list here</b>, for the reason <c>KafkaImporterConfig</c> gives: every field
/// a step names is one a workflow author chooses, and the broker is org infrastructure that is the
/// same for every step this deployment will ever run. It arrives from configuration as
/// <c>Kafka__BrokerList</c> instead. See <see cref="Kafka.KafkaBrokerOptions"/>. Payloads written
/// while it lived here still carry the key; binding ignores it, so the leftover is inert.
/// </para>
/// <para>
/// <b>There is no consumer group and no message count either, and their absence is the shape of the
/// step.</b> An export handles exactly one input — the branch the orchestrator dispatched — so there
/// is nothing to count and no group to join. <c>DeliveryTimeoutSeconds</c> is the one field with no
/// counterpart on the importer: see <c>KafkaProducerSettings</c> for why waiting for an
/// acknowledgement needs a bound that the author, not the framework, chooses. It lives on
/// <c>ExporterConfig</c> now, because the framework validates it; it is passed straight through this
/// record's own primary constructor, so the JSON shape is unchanged.
/// </para>
/// </summary>
public sealed record KafkaExporterConfig(
    string Topic,
    int DeliveryTimeoutSeconds) : ExporterConfig(DeliveryTimeoutSeconds);
