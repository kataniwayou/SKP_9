using Confluent.Kafka;
using Processor.PathImporter.Kafka;

namespace BaseApi.Tests.PathImporter;

/// <summary>
/// The seam, scripted. Records are queued up front; faults are scheduled by position, so a test says
/// "the fourth consume throws" rather than reaching into the loop.
/// </summary>
internal sealed class FakePathConsumer : IPathConsumer
{
    private readonly Queue<PathRecord> _records = new();
    private int _consumeCalls;

    public List<string> Committed { get; } = new();
    public List<string> Subscribed { get; } = new();
    public bool Closed { get; private set; }
    public bool Disposed { get; private set; }

    /// <summary>False makes WaitForAssignment time out, as an unjoined group would.</summary>
    public bool Assigned { get; set; } = true;

    /// <summary>1-based index of the Consume call that throws; null means none ever does.</summary>
    public int? ConsumeThrowsOnCall { get; set; }

    /// <summary>1-based index of the Commit call that throws; null means none ever does.</summary>
    public int? CommitThrowsOnCall { get; set; }

    public Error Fault { get; set; } = new(ErrorCode.Local_Transport);

    public FakePathConsumer WithPaths(params string[] paths)
    {
        for (var i = 0; i < paths.Length; i++)
        {
            _records.Enqueue(new PathRecord(paths[i], $"file-paths [0] @{i}"));
        }

        return this;
    }

    public void Subscribe(string topic) => Subscribed.Add(topic);

    public bool WaitForAssignment(TimeSpan timeout) => Assigned;

    public PathRecord? Consume(TimeSpan timeout)
    {
        _consumeCalls++;
        if (_consumeCalls == ConsumeThrowsOnCall)
        {
            throw new KafkaException(Fault);
        }

        return _records.Count == 0 ? null : _records.Dequeue();
    }

    public void Commit(PathRecord record)
    {
        if (Committed.Count + 1 == CommitThrowsOnCall)
        {
            throw new KafkaException(Fault);
        }

        Committed.Add(record.Path);
    }

    public void Close() => Closed = true;

    public void Dispose() => Disposed = true;
}

/// <summary>Hands out one scripted consumer and counts how often it was asked for a new one.</summary>
internal sealed class FakePathConsumerFactory(params FakePathConsumer[] consumers) : IPathConsumerFactory
{
    private int _created;

    public int Created => _created;
    public List<(string Brokers, string Group)> Requests { get; } = new();

    public IPathConsumer Create(string brokerList, string consumerGroup)
    {
        Requests.Add((brokerList, consumerGroup));
        return consumers[_created++];
    }
}
