using System.Text;
using Confluent.Kafka;
using Processor.KafkaImporter.Kafka;

namespace BaseApi.Tests.KafkaImporter;

/// <summary>
/// The seam, scripted. Records are queued up front; faults are scheduled by position, so a test says
/// "the fourth consume throws" rather than reaching into the loop.
/// </summary>
internal sealed class FakeRecordConsumer : IRecordConsumer
{
    private readonly Queue<KafkaRecord> _records = new();
    private int _consumeCalls;
    private KafkaRecord? _lastConsumed;

    /// <summary>
    /// Decoded, because every test that reads this is asserting on text it queued as text. The loop
    /// never decodes anything — see <c>KafkaRecord</c> — so this is a convenience of the fake and not
    /// a claim about the processor.
    /// </summary>
    public List<string> Committed { get; } = new();

    public List<string> Subscribed { get; } = new();
    public bool Closed { get; private set; }
    public bool Disposed { get; private set; }

    /// <summary>False makes WaitForAssignment time out, as an unjoined group would.</summary>
    public bool Assigned { get; set; } = true;

    /// <summary>
    /// True makes <see cref="WaitForAssignment"/> throw <see cref="Fault"/> instead of returning.
    /// Mirrors <see cref="ConsumeThrowsOnCall"/> so the fault-classification arms around the wait —
    /// otherwise unreachable from this fake, since <c>=&gt; Assigned</c> could never throw — have a
    /// hermetic path to exercise them.
    /// </summary>
    public bool AssignmentThrows { get; set; }

    /// <summary>1-based index of the Consume call that throws; null means none ever does.</summary>
    public int? ConsumeThrowsOnCall { get; set; }

    /// <summary>1-based index of the Commit call that throws; null means none ever does.</summary>
    public int? CommitThrowsOnCall { get; set; }

    public Error Fault { get; set; } = new(ErrorCode.Local_Transport);

    /// <summary>Queues records whose values are the UTF-8 encoding of these strings.</summary>
    public FakeRecordConsumer WithRecords(params string[] values)
        => WithRecords(values.Select(Encoding.UTF8.GetBytes).ToArray());

    /// <summary>
    /// Queues records with exactly these bytes. The overload exists so a test can queue a value that
    /// is not valid UTF-8 and prove the loop hands it through untouched — the one fact the
    /// string-based overload above cannot express.
    /// </summary>
    public FakeRecordConsumer WithRecords(params byte[][] values)
    {
        for (var i = 0; i < values.Length; i++)
        {
            _records.Enqueue(new KafkaRecord(values[i], $"records [0] @{i}"));
        }

        return this;
    }

    public void Subscribe(string topic) => Subscribed.Add(topic);

    public bool WaitForAssignment(TimeSpan timeout)
    {
        if (AssignmentThrows)
        {
            throw new KafkaException(Fault);
        }

        return Assigned;
    }

    public KafkaRecord? Consume(TimeSpan timeout)
    {
        _consumeCalls++;
        if (_consumeCalls == ConsumeThrowsOnCall)
        {
            throw new KafkaException(Fault);
        }

        if (_records.Count == 0)
        {
            return null;
        }

        var record = _records.Dequeue();
        _lastConsumed = record;
        return record;
    }

    /// <summary>
    /// Enforced here BECAUSE <c>KafkaRecordConsumer.Commit</c> enforces it against a real broker: it
    /// asserts that <paramref name="record"/> is the record it last handed out and throws
    /// <see cref="InvalidOperationException"/> otherwise. This fake must refuse the same thing, or a
    /// loop that batches commits -- or commits any record but the last -- would pass every hermetic
    /// fact here and throw on the first real broker call, since that adapter is the one file no test
    /// can reach to catch the two contracts drifting apart. The two must not drift.
    /// <para>
    /// <c>ReferenceEquals</c>, not <c>!=</c>, and the distinction is worth stating: a positional
    /// record compares its <c>byte[]</c> member by reference anyway, so the two agree today — but
    /// only by accident of the member's type. Saying "the same object" outright keeps this check
    /// meaning what it is for if <c>KafkaRecord</c> ever grows a member that compares by value.
    /// </para>
    /// </summary>
    public void Commit(KafkaRecord record)
    {
        if (_lastConsumed is null)
        {
            throw new InvalidOperationException(
                "FakeRecordConsumer.Commit was called before Consume returned a record; the loop " +
                "must consume each record before acknowledging it.");
        }

        if (!ReferenceEquals(record, _lastConsumed))
        {
            throw new InvalidOperationException(
                $"FakeRecordConsumer.Commit was given the record at {record.Offset} but the last " +
                $"record handed out was the one at {_lastConsumed.Offset}. This fake commits the " +
                "record it last returned, so each record must be committed before the next is " +
                "consumed.");
        }

        if (Committed.Count + 1 == CommitThrowsOnCall)
        {
            throw new KafkaException(Fault);
        }

        Committed.Add(Encoding.UTF8.GetString(record.Value));
    }

    public void Close() => Closed = true;

    public void Dispose() => Disposed = true;
}

/// <summary>Hands out one scripted consumer and counts how often it was asked for a new one.</summary>
internal sealed class FakeRecordConsumerFactory(params FakeRecordConsumer[] consumers) : IRecordConsumerFactory
{
    private int _created;

    public int Created => _created;

    /// <summary>
    /// The groups asked for, in order. <b>No broker list</b>: the production factory holds the org's
    /// broker from configuration and a caller cannot name one, so there is nothing per-call to
    /// record but the group.
    /// </summary>
    public List<string> Requests { get; } = new();

    /// <summary>
    /// True makes <see cref="Create"/> throw <see cref="Fault"/> instead of handing out a consumer,
    /// so the fault-classification arms around <c>Rent</c> — otherwise unreachable, since neither
    /// this factory nor <see cref="FakeRecordConsumer.Subscribe"/> could ever throw — have a hermetic
    /// path to exercise them.
    /// </summary>
    public bool CreateThrows { get; set; }

    public Error Fault { get; set; } = new(ErrorCode.Local_Transport);

    public IRecordConsumer Create(string consumerGroup)
    {
        Requests.Add(consumerGroup);
        if (CreateThrows)
        {
            throw new KafkaException(Fault);
        }

        return consumers[_created++];
    }
}
