using BaseProcessor.Core.Edge;
using Confluent.Kafka;

namespace Processor.KafkaImporter.Kafka;

/// <summary>
/// The adapter: <see cref="IRecordConsumer"/> presented as the framework's <see cref="IImportSource"/>.
/// It is the only place in this processor where Kafka and the edge contract meet, and it is where the
/// consumer seam finally becomes a whole one — <see cref="IRecordConsumer"/> hands back a
/// Confluent-free <see cref="KafkaRecord"/> and then lets Confluent's <see cref="KafkaException"/>
/// straight through, so something has to convert it. The importer's loop cannot: it must not know
/// what a <see cref="KafkaException"/> is, and it must not catch bare <see cref="Exception"/> either,
/// because <c>PostSendException</c> has to reach the framework untouched.
/// <para>
/// <b>Only <see cref="KafkaException"/> is converted.</b> An <see cref="InvalidOperationException"/>
/// from the commit contract below is a programming error and is deliberately left to escape as
/// itself, so the framework logs it at Warning with its stack trace instead of flattening it into one
/// <c>FailedException</c> line.
/// </para>
/// </summary>
internal sealed class KafkaImportSource(IRecordConsumer consumer, string topic) : IImportSource
{
    private bool _subscribed;
    private KafkaRecord? _lastRecord;
    private ImportedItem? _lastItem;

    /// <summary>
    /// Subscribe once, then wait for an assignment on every dispatch.
    /// <para>
    /// The split matters. Subscribing is per consumer — librdkafka's is non-blocking and idempotent
    /// but the group join it triggers is not free — while assignment is <b>not</b> a property the
    /// consumer keeps: a rebalance between dispatches can take the partition away, and a consumer
    /// that polls without one returns nothing, which is indistinguishable from a drained topic. So
    /// the question is asked again every time.
    /// </para>
    /// <para>
    /// Per §8 of the design, <c>Subscribe</c> does not throw on a nonexistent topic or a missing
    /// authorization grant — the error surfaces on the first read after it, which in production is
    /// the read inside <c>WaitForAssignment</c>. So this is also where a mis-authored payload lands.
    /// </para>
    /// </summary>
    public bool Open(TimeSpan timeout)
    {
        try
        {
            if (!_subscribed)
            {
                consumer.Subscribe(topic);
                _subscribed = true;
            }

            return consumer.WaitForAssignment(timeout);
        }
        catch (KafkaException ex)
        {
            throw new ImportSourceException(ex.Error.Code.ToString(), ex);
        }
    }

    /// <summary>
    /// One record, or null when the assignment is drained.
    /// <para>
    /// The record is kept alongside the item it became, because <see cref="Acknowledge"/> is handed
    /// the item and <see cref="IRecordConsumer.Commit"/> wants the record. <c>Origin</c> is the
    /// rendered offset, which is what the importer's log line has always named.
    /// </para>
    /// </summary>
    public ImportedItem? Read(TimeSpan timeout)
    {
        KafkaRecord? record;
        try
        {
            record = consumer.Consume(timeout);
        }
        catch (KafkaException ex)
        {
            throw new ImportSourceException(ex.Error.Code.ToString(), ex);
        }

        if (record is null)
        {
            return null;
        }

        // The bytes cross untouched: KafkaRecord.Value IS ImportedItem.Data, same array, no copy and
        // no decode. Decoding here would make invalid UTF-8 into replacement characters silently, and
        // the branch would carry data the topic never held.
        _lastRecord = record;
        _lastItem = new ImportedItem(record.Value, record.Offset);
        return _lastItem;
    }

    /// <summary>
    /// The commit, and it enforces the seam's contract rather than trusting it: the item must be the
    /// one <see cref="Read"/> last handed out. <c>KafkaRecordConsumer.Commit</c> enforces the same
    /// thing against a real broker and so does the hermetic suite's fake, so a loop that batched
    /// acknowledgements would fail identically against either — and this is the layer that would
    /// otherwise quietly translate a batched acknowledgement into a legal-looking commit.
    /// </summary>
    public void Acknowledge(ImportedItem item)
    {
        if (_lastRecord is null || !ReferenceEquals(item, _lastItem))
        {
            throw new InvalidOperationException(
                $"KafkaImportSource was asked to acknowledge the item from {item.Origin} but the " +
                $"last item it handed out was {(_lastItem is null ? "none" : _lastItem.Origin)}. " +
                "Each item must be acknowledged before the next is read.");
        }

        try
        {
            consumer.Commit(_lastRecord);
        }
        catch (KafkaException ex)
        {
            throw new ImportSourceException(ex.Error.Code.ToString(), ex);
        }
    }

    public void Close() => consumer.Close();

    public void Dispose() => consumer.Dispose();
}
