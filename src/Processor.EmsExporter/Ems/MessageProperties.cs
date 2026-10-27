namespace Processor.EmsExporter.Ems;

/// <summary>
/// The properties every exported message carries.
/// <para>
/// <b><see cref="ExecutionId"/> is the EMS spelling of the <c>execution-id</c> header</b> that
/// <c>Processor.KafkaExporter</c> writes and <c>Processor.KafkaImporter</c> reads. JMS property names
/// must be Java identifiers, so the hyphen cannot survive; the value is the same GUID <c>D</c> text.
/// </para>
/// <para>
/// <b>Not <c>JMSCorrelationID</c>.</b> That header belongs to request/reply by convention, and a
/// consumer using it that way would read our GUID as a reply correlation.
/// </para>
/// <para>
/// <b>A consumer must deduplicate on it.</b> EMS has no idempotent producer: a reconnect mid-send,
/// or the replay this processor accepts after a failed completion, can deliver the same message
/// twice, and both copies carry the same id.
/// </para>
/// </summary>
public static class MessageProperties
{
    public const string ExecutionId = "executionId";
}
