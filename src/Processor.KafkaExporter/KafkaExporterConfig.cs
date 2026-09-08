using BaseProcessor.Core.Configuration;

namespace Processor.KafkaExporter;

/// <summary>
/// The step payload, flat: three scalars and no nesting. The framework binds it case-insensitively
/// and ignores unknown properties, so <c>{"brokerList":"kafka:9092","topic":"records",
/// "deliveryTimeoutSeconds":30}</c> binds, and a fourth field added later does not break workflows
/// authored before it.
/// <para>
/// <b>The broker list travels in the payload rather than in configuration</b>, for the same reason
/// it does in <c>KafkaImporterConfig</c>: it lets one deployment serve several topics on several
/// clusters without a redeploy, and it keeps every field of this record answering the same question
/// the same way.
/// </para>
/// <para>
/// <b>There is no consumer group and no message count, and their absence is the shape of the step.</b>
/// An export handles exactly one input — the branch the orchestrator dispatched — so there is nothing
/// to count and no group to join. <c>DeliveryTimeoutSeconds</c> is the one field with no counterpart
/// on the importer: see <c>KafkaProducerSettings</c> for why waiting for an acknowledgement needs a
/// bound that the author, not the framework, chooses. It lives on
/// <c>ExporterConfig</c> now, because the framework validates it; it is passed straight through this
/// record's own primary constructor, so the JSON shape is unchanged.
/// </para>
/// </summary>
public sealed record KafkaExporterConfig(
    string BrokerList,
    string Topic,
    int DeliveryTimeoutSeconds) : ExporterConfig(DeliveryTimeoutSeconds);
