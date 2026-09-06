namespace Processor.PathImporter.Kafka;

/// <summary>
/// One consumed record. <paramref name="Path"/> is the record's value and is the whole of it — a
/// Kafka record on this topic is a full file path, with no envelope and nothing to deserialize,
/// which is what makes it the branch's data directly.
/// <para>
/// <paramref name="Offset"/> is rendered rather than typed so that no Confluent type crosses this
/// seam. It is for the log line only; <see cref="IPathConsumer.Commit"/> takes the record back and
/// the adapter recovers whatever it needs from its own state.
/// </para>
/// </summary>
public sealed record PathRecord(string Path, string Offset);
