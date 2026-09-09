using BaseProcessor.Core.Edge;
using Confluent.Kafka;
using Microsoft.Extensions.Logging;
using Processor.KafkaExporter.Kafka;

namespace Processor.KafkaExporter;

/// <summary>
/// Produces a branch's data to a Kafka topic and ends the lineage there.
/// <para>
/// <b>Everything about how an edge behaves lives in <see cref="BaseExporter{TConfig}"/>.</b> The edge
/// guard, the payload and empty-data guards, the cache with evict-on-fault, the one write, the
/// converge-on-one-throw failure rule and the log line are all there and are the same for every
/// exporter. What is Kafka here is what is left: a config record, an adapter, the delivery-timeout
/// floor, and the three answers below.
/// </para>
/// </summary>
public sealed class KafkaExporterProcessor(
    IRecordProducerFactory factory,
    ILogger<KafkaExporterProcessor> logger)
    : BaseExporter<KafkaExporterConfig>(logger)
{
    protected override string RequiredPayload => "topic and deliveryTimeoutSeconds";

    /// <summary>
    /// <b>The delivery timeout, and nothing else.</b> The topic is not in the key — a producer is not
    /// bound to one, and building a second producer per topic would pay a connection and a metadata
    /// fetch for nothing. The timeout IS, because that one is fixed at construction: a cached producer
    /// carries the timeout it was built with, and without this a dispatch naming a longer timeout
    /// would silently get the shorter one it inherited.
    /// <para>
    /// The broker used to lead this key. It left with the payload field: one deployment writes to one
    /// org cluster, named once in configuration, so there is nothing left for a step to vary that
    /// would warrant a second producer.
    /// </para>
    /// </summary>
    protected override string CacheKey(KafkaExporterConfig config) =>
        config.DeliveryTimeoutSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture);

    protected override string Destination(KafkaExporterConfig config) => config.Topic;

    /// <summary>
    /// Raised above the framework's floor of one because librdkafka's own is: see
    /// <see cref="KafkaProducerSettings.MinimumDeliveryTimeout"/> for why a <c>message.timeout.ms</c>
    /// of 0 means "no timeout" and would hold this replica's only lane until the broker answered or
    /// the pod died.
    /// </summary>
    protected override int MinimumDeliveryTimeoutSeconds =>
        (int)KafkaProducerSettings.MinimumDeliveryTimeout.TotalSeconds;

    /// <summary>
    /// <b>The factory throws Confluent's exception, so this is where it stops being one</b>, for the
    /// reason <c>KafkaImporterProcessor.CreateSource</c> gives: building the handle reaches
    /// librdkafka, which rejects a malformed broker list outright — a deployment's misconfiguration
    /// now rather than a step's — and the base class must not know what a
    /// <see cref="KafkaException"/> is.
    /// </summary>
    protected override IExportSink CreateSink(KafkaExporterConfig config)
    {
        try
        {
            return new KafkaExportSink(
                factory.Create(TimeSpan.FromSeconds(config.DeliveryTimeoutSeconds)));
        }
        catch (KafkaException ex)
        {
            throw new ExportSinkException(ex.Error.Code.ToString(), ex);
        }
    }
}
