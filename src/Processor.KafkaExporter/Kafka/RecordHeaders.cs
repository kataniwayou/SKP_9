namespace Processor.KafkaExporter.Kafka;

/// <summary>
/// The headers every exported record carries.
/// <para>
/// <b><see cref="ExecutionId"/> is the same header <c>Processor.KafkaImporter</c> reads</b> (2026-10-19, the user's
/// "symmetric principle"): the importer takes each record's lineage from it, so the exporter writes the execution it
/// was dispatched with into it, and an importer reading the exporter's topic carries that execution on. The value is
/// the GUID's <c>D</c> text in UTF-8, as the importer and the feeds expect. Kept here rather than in a shared library,
/// as the importer keeps its own: the two processors are separate author projects, and the header name is their
/// contract, written down on both sides.
/// </para>
/// </summary>
public static class RecordHeaders
{
    /// <summary>The header the record's lineage rides in (§7 of the in-process post design).</summary>
    public const string ExecutionId = "execution-id";
}
