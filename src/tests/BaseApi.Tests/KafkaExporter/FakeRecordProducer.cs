using Confluent.Kafka;
using Processor.KafkaExporter.Kafka;

namespace BaseApi.Tests.KafkaExporter;

/// <summary>
/// The seam, scripted. Every produce is recorded; faults are scheduled by position, so a test says
/// "the second produce throws" rather than reaching into the step.
/// </summary>
internal sealed class FakeRecordProducer : IRecordProducer
{
    private int _produceCalls;

    public List<(string Topic, byte[] Value)> Produced { get; } = new();
    public bool Disposed { get; private set; }

    /// <summary>1-based index of the ProduceAsync call that throws; null means none ever does.</summary>
    public int? ProduceThrowsOnCall { get; set; }

    public Error Fault { get; set; } = new(ErrorCode.Local_Transport);

    /// <summary>
    /// Recorded BEFORE the scheduled fault fires, deliberately. A produce that throws may still have
    /// reached the broker — the <c>PossiblyPersisted</c> case the adapter converts into exactly this
    /// exception — so a fake that recorded nothing would be asserting a guarantee the real client
    /// does not offer. Tests that care about the difference read <see cref="Produced"/>; tests about
    /// the step's outcome do not look at it at all.
    /// </summary>
    public Task<string> ProduceAsync(string topic, byte[] value, CancellationToken ct)
    {
        _produceCalls++;
        Produced.Add((topic, value));

        if (_produceCalls == ProduceThrowsOnCall)
        {
            throw new KafkaException(Fault);
        }

        return Task.FromResult($"{topic} [0] @{_produceCalls - 1}");
    }

    public void Dispose() => Disposed = true;
}

/// <summary>Hands out one scripted producer and counts how often it was asked for a new one.</summary>
internal sealed class FakeRecordProducerFactory(params FakeRecordProducer[] producers) : IRecordProducerFactory
{
    private int _created;

    public int Created => _created;

    /// <summary>
    /// The delivery timeouts asked for, in order. <b>No broker list</b>: the production factory
    /// holds the org's broker from configuration and a caller cannot name one, so the timeout is
    /// all that varies per call.
    /// </summary>
    public List<TimeSpan> Requests { get; } = new();

    /// <summary>
    /// True makes <see cref="Create"/> throw <see cref="Fault"/> instead of handing out a producer.
    /// The real factory builds a librdkafka handle, which can fail on a malformed broker list, and
    /// this is the only hermetic way to reach the step's Rent failure path.
    /// </summary>
    public bool CreateThrows { get; set; }

    public Error Fault { get; set; } = new(ErrorCode.Local_Transport);

    public IRecordProducer Create(TimeSpan deliveryTimeout)
    {
        Requests.Add(deliveryTimeout);
        if (CreateThrows)
        {
            throw new KafkaException(Fault);
        }

        return producers[_created++];
    }
}
