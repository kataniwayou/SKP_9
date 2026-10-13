using System.Text;
using Confluent.Kafka;
using Processor.KafkaImporter.Kafka;

namespace BaseApi.Tests.Live;

/// <summary>
/// What every Live test that feeds KafkaImporter must stamp on its records. The importer refuses a
/// record with no <c>execution-id</c> header (the lineage rides the header, never the value), so a
/// producer that omits it ends the lineage at the first hop.
/// </summary>
internal static class LiveKafka
{
    /// <summary>
    /// Fresh headers carrying <c>execution-id</c> = a new GUID's <c>D</c> text in UTF-8. Fresh per
    /// record: each test record is its own lineage.
    /// </summary>
    public static Headers ExecutionHeaders() =>
        new() { { KafkaRecord.ExecutionIdHeader, Encoding.UTF8.GetBytes(Guid.NewGuid().ToString("D")) } };
}
