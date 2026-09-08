using Confluent.Kafka;

namespace Processor.KafkaExporter.Kafka;

/// <summary>
/// The client settings, split out from the adapter because this is the half that can be asserted
/// without a broker — and every value here is load-bearing rather than tuning.
/// </summary>
public static class KafkaProducerSettings
{
    /// <summary>
    /// The floor <c>DeliveryTimeoutSeconds</c> is validated against, and the reason it is validated
    /// at all: librdkafka rejects a <c>message.timeout.ms</c> of 0, which means "no timeout", and a
    /// step that waited forever for an acknowledgement would hold its dispatch slot forever with
    /// nothing to report. One second is the smallest value that is still a timeout.
    /// </summary>
    public static readonly TimeSpan MinimumDeliveryTimeout = TimeSpan.FromSeconds(1);

    /// <summary>
    /// <b>The default this replaces is five minutes, and that is why the timeout is a payload field
    /// rather than a constant.</b> librdkafka's <c>message.timeout.ms</c> defaults to 300000, so an
    /// export to a broker that has gone away holds the dispatch — and, at a prefetch of one, this
    /// replica's only lane — for five minutes before failing. Nothing in the framework interrupts
    /// it: <c>ProcessAsync</c>'s cancellation token is never cancelled in production, by design.
    /// <para>
    /// A workflow author knows how long their step may reasonably block and the framework does not,
    /// so the value travels in the step payload. It is applied at CONSTRUCTION, which is why
    /// <c>KafkaExporterProcessor</c>'s cache keys on it alongside the broker list: a cached producer
    /// carries the timeout it was built with, and a later dispatch naming a different one gets a new
    /// producer rather than silently keeping the old value.
    /// </para>
    /// </summary>
    public static ProducerConfig For(string brokerList, TimeSpan deliveryTimeout) => new()
    {
        BootstrapServers = brokerList,

        // The pair that makes "returned normally" mean "the broker persisted it".
        //
        // Acks.All waits for the in-sync replicas rather than the leader alone, so an acknowledgement
        // survives the leader failing immediately afterwards. EnableIdempotence stops the retries
        // librdkafka performs underneath from turning one produce into several records on the
        // partition -- without it, a retry after an acknowledgement this client never saw is a
        // duplicate nobody records. Idempotence also implies Acks.All; naming both keeps the
        // guarantee readable rather than implied by a side effect.
        Acks = Acks.All,
        EnableIdempotence = true,

        MessageTimeoutMs = (int)deliveryTimeout.TotalMilliseconds,
    };
}
