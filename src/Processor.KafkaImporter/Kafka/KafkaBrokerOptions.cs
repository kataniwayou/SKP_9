namespace Processor.KafkaImporter.Kafka;

/// <summary>
/// The org's broker, bound from the <c>"Kafka"</c> config section.
/// <para>
/// <b>This is here rather than in the step payload because the broker is not the workflow author's
/// to choose.</b> The cluster is org infrastructure, standing outside this deployment and owned by
/// someone else; a topic and a consumer group are names an author picks, and an address is not.
/// Keeping it in configuration also means the credentials that will one day authenticate to it can
/// arrive the same way — from a <c>secretKeyRef</c>, alongside <c>RabbitMq__Password</c> — rather
/// than in an assignment row, which is plaintext <c>jsonb</c> served by the API and editable as
/// ordinary workflow authoring.
/// </para>
/// <para>
/// A settable property on a class, matching <c>ProcessorLivenessOptions</c>, so the configuration
/// binder can fill it. Unlike that one it is registered as a validated singleton rather than through
/// <c>IOptions</c>: those options all have a sensible default and this has none, so it is bound
/// eagerly at host construction — see <c>ProcessorHost.Create</c> for why a blank one must stop the
/// host rather than the first dispatch.
/// </para>
/// </summary>
public sealed class KafkaBrokerOptions
{
    /// <summary>The bootstrap servers, librdkafka's own comma-separated form.</summary>
    public string BrokerList { get; set; } = "";
}
