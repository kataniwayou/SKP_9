namespace Processor.KafkaExporter.Kafka;

/// <summary>
/// Everything the step knows about Kafka, which is one verb. The narrowness is the point, and it is
/// the same bargain <c>Processor.KafkaImporter</c>'s consumer seam makes: it is what lets every
/// terminal rule and the producer cache be tested against a fake, with no broker anywhere in the
/// hermetic suite.
/// </summary>
public interface IRecordProducer : IDisposable
{
    /// <summary>
    /// Produces <paramref name="value"/> to <paramref name="topic"/> and does not return until the
    /// broker has acknowledged it.
    /// <para>
    /// <b>The wait is the whole contract.</b> A fire-and-forget produce returns before the record
    /// exists anywhere durable, so a step that reported Complete on that would be reporting the
    /// enqueue rather than the export — and a broker that went away a moment later would lose the
    /// record with a green workflow recording that it had landed. An implementation that cannot wait
    /// for an acknowledgement does not satisfy this interface.
    /// </para>
    /// <para>
    /// <b>Binding on every implementation:</b> returning normally means the broker persisted the
    /// record. Anything else — a rejection, a timeout, an acknowledgement that admits it might not
    /// have persisted — throws. There is no third answer, because the step above has only two
    /// outcomes to report.
    /// </para>
    /// </summary>
    /// <returns>
    /// The rendered topic/partition/offset the record landed at, for the log line. Rendered rather
    /// than typed so that no Confluent type crosses this seam.
    /// </returns>
    Task<string> ProduceAsync(string topic, byte[] value, CancellationToken ct);
}
