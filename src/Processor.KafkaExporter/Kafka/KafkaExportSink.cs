using BaseProcessor.Core.Edge;
using Confluent.Kafka;

namespace Processor.KafkaExporter.Kafka;

/// <summary>
/// The adapter: <see cref="IRecordProducer"/> presented as the framework's <see cref="IExportSink"/>.
/// The mirror of <c>KafkaImportSource</c> and it exists for the same reason — the step above must not
/// know what a <see cref="KafkaException"/> is, and something has to convert it.
/// <para>
/// <b>Only <see cref="KafkaException"/> is converted.</b> Anything else is a programming error and
/// escapes as itself, so the framework logs it at Warning with its stack trace rather than flattening
/// it into one <c>FailedException</c> line.
/// </para>
/// <para>
/// The destination arrives per write rather than at construction, which is what the seam's shape was
/// already saying: a producer is not bound to a topic, so one sink serves every topic a workflow
/// names against the same broker list.
/// </para>
/// </summary>
internal sealed class KafkaExportSink(IRecordProducer producer) : IExportSink
{
    public async Task<string> WriteAsync(string destination, byte[] data, CancellationToken ct)
    {
        try
        {
            return await producer.ProduceAsync(destination, data, ct).ConfigureAwait(false);
        }
        catch (KafkaException ex)
        {
            throw new ExportSinkException(ex.Error.Code.ToString(), ex);
        }
    }

    public void Dispose() => producer.Dispose();
}
