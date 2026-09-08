namespace Processor.KafkaImporter.Kafka;

/// <summary>
/// One consumed record. <paramref name="Value"/> is the record's value and is the whole of it — this
/// processor imports whatever the topic carries without interpreting it, so there is no envelope to
/// open and nothing to deserialize. The bytes handed over here are the bytes the branch is sent with.
/// <para>
/// <b>Bytes rather than a string, and that is the whole of "as is".</b> Decoding the value to a
/// string here and re-encoding it on the way out is lossless only for valid UTF-8: anything else
/// comes back as replacement characters, silently, with the branch carrying data the topic never
/// held. Since nothing in this processor reads the value, there is no reason to decode it at all —
/// except for the log line, which decodes a copy and says so.
/// </para>
/// <para>
/// <paramref name="Offset"/> is rendered rather than typed so that no Confluent type crosses this
/// seam. It is for the log line only; <see cref="IRecordConsumer.Commit"/> takes the record back and
/// the adapter recovers whatever it needs from its own state.
/// </para>
/// <para>
/// <b>This record's equality is reference equality on <paramref name="Value"/>.</b> A positional
/// record compares an array member by reference, not by contents, which is exactly what the commit
/// contract wants — <c>Commit</c> asks "is this the record I handed out", not "is this an equal one"
/// — but it is worth knowing before anyone reaches for <c>==</c> expecting a value comparison.
/// </para>
/// </summary>
public sealed record KafkaRecord(byte[] Value, string Offset);
