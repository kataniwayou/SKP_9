using System.Text;
using BaseProcessor.Core.Edge;
using Confluent.Kafka;
using Microsoft.Extensions.Logging;
using Processor.KafkaImporter.Kafka;

namespace Processor.KafkaImporter;

/// <summary>
/// Reads a topic and opens one lineage per record, sending each record's value downstream as is.
/// <para>
/// <b>Everything about how an edge behaves lives in <see cref="BaseImporter{TConfig}"/>.</b> The edge
/// guard, the payload guards, the one-item cache with evict-on-fault, the two-part split, the three
/// terminals, send-then-acknowledge ordering and the log lines are all there and are the same for
/// every importer. What is Kafka here is what is left: a config record, an adapter, and the three
/// answers below.
/// </para>
/// </summary>
public sealed class KafkaImporterProcessor(
    IRecordConsumerFactory factory,
    ILogger<KafkaImporterProcessor> logger)
    : BaseImporter<KafkaImporterConfig>(logger)
{
    protected override string RequiredPayload =>
        "topic, consumerGroup, messageCount and idleTimeoutSeconds";

    /// <summary>
    /// <b>Topic and group, which is now everything a step can vary.</b> A subscribed consumer is
    /// bound to both, so a step naming a different topic or a different group is a different source
    /// and must get a different consumer rather than silently inheriting this one's subscription.
    /// <para>
    /// The broker used to lead this key and no longer appears in it, because it no longer varies:
    /// one deployment reads one org cluster, named once in configuration, and a consumer built
    /// against a different one is not something a payload can ask for.
    /// </para>
    /// </summary>
    protected override string CacheKey(KafkaImporterConfig config) =>
        $"{config.Topic}|{config.ConsumerGroup}";

    /// <summary>The topic, which is the phrase an operator reading a failure message wants.</summary>
    protected override string SourceName(KafkaImporterConfig config) => config.Topic;

    /// <summary>
    /// <b>The factory throws Confluent's exception, so this is where it stops being one.</b> Building
    /// a consumer reaches librdkafka, which rejects a malformed broker list outright, and
    /// <see cref="IRecordConsumerFactory"/> is Confluent-free in what it returns but not in what it
    /// throws — and a malformed broker list is now a deployment's misconfiguration rather than a
    /// step's, which makes this the arm that reports it. The base class must not know what a
    /// <see cref="KafkaException"/> is, so the conversion belongs here alongside the one
    /// <c>KafkaImportSource</c> does for the verbs.
    /// </summary>
    protected override IImportSource CreateSource(KafkaImporterConfig config)
    {
        try
        {
            return new KafkaImportSource(factory.Create(config.ConsumerGroup), config.Topic);
        }
        catch (KafkaException ex)
        {
            throw new ImportSourceException(ex.Error.Code.ToString(), ex);
        }
    }

    /// <summary>
    /// <b>The override that keeps this processor's existing log line.</b> Without it the base logs
    /// the origin alone — for a topic, the rendered offset — and the record value would stop appearing
    /// in Elasticsearch.
    /// <para>
    /// It renders runtime data, which <c>SampleProcessor</c> forbids at length. The exception is
    /// narrow and deliberate: the record value is not derived content, it is the business identifier
    /// and the only thing an operator would search for. Two consequences that were acceptable for a
    /// file path and are worth restating now the value is arbitrary: record values land in
    /// Elasticsearch in the clear, and nothing here truncates them, so a topic of large values writes
    /// large log lines. The mitigation, if either ever stops being acceptable, is to hash or truncate
    /// in this method — which is precisely why the base asks a subclass rather than deciding.
    /// </para>
    /// <para>
    /// <b>THE DECODE IS FOR THE LOG AND ONLY FOR THE LOG.</b> The branch carries
    /// <see cref="ImportedItem.Data"/> untouched; this renders a copy, and invalid UTF-8 becomes
    /// replacement characters HERE rather than in the data — which is the whole reason the seam
    /// carries bytes. See <c>KafkaRecord</c>.
    /// </para>
    /// </summary>
    protected override string Describe(ImportedItem item) => Encoding.UTF8.GetString(item.Data);
}
