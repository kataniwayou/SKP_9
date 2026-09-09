namespace Processor.KafkaExporter.Kafka;

/// <summary>
/// The org's broker, bound from the <c>"Kafka"</c> config section.
/// <para>
/// <b>This is here rather than in the step payload because the broker is not the workflow author's
/// to choose.</b> The cluster is org infrastructure, standing outside this deployment and owned by
/// someone else; a topic is a name an author picks, and an address is not. Keeping it in
/// configuration also means the credentials that will one day authenticate to it can arrive the same
/// way — from a <c>secretKeyRef</c>, alongside <c>RabbitMq__Password</c> — rather than in an
/// assignment row, which is plaintext <c>jsonb</c> served by the API and editable as ordinary
/// workflow authoring.
/// </para>
/// <para>
/// Duplicated from the importer's type of the same name rather than shared, matching how
/// <c>IRecordProducerFactory</c> and its consumer counterpart already stand apart: the two
/// processors ship as separate images with separate Kafka folders, and neither depends on the other.
/// </para>
/// </summary>
public sealed class KafkaBrokerOptions
{
    /// <summary>The bootstrap servers, librdkafka's own comma-separated form.</summary>
    public string BrokerList { get; set; } = "";
}
