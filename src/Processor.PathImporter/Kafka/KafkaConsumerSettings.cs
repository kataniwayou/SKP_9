using Confluent.Kafka;

namespace Processor.PathImporter.Kafka;

/// <summary>
/// The client settings, split out from the adapter because this is the half that can be asserted
/// without a broker — and three of these four values are load-bearing rather than tuning.
/// </summary>
public static class KafkaConsumerSettings
{
    /// <summary>
    /// How long librdkafka tolerates between polls before removing this consumer from the group.
    /// <para>
    /// Raised from its five-minute default because the consumer is held across dispatches and
    /// nothing polls in between, so any ordinary idle gap would evict it and the next dispatch would
    /// pay the rejoin the cache exists to avoid. Safe, because this is not what detects a dead
    /// consumer: <c>session.timeout.ms</c> is, it runs on librdkafka's own heartbeat thread, it is
    /// left at its default, and it releases the partition promptly when a pod dies. This governs
    /// livelock only, and a livelocked author here is already a wedged dispatch the framework's
    /// liveness and queue-depth signals surface.
    /// </para>
    /// <para>
    /// <b>Do not "solve" this with a background keepalive poll.</b> Consume is what resets the
    /// interval and Consume is what returns records, so a keepalive would consume paths outside a
    /// dispatch — with no execution id to mint them under, no branch to send them on and no scope to
    /// log them in — and commit them away. It is the obvious idea and it destroys data silently.
    /// </para>
    /// </summary>
    public static readonly TimeSpan MaxPollInterval = TimeSpan.FromHours(1);

    public static ConsumerConfig For(string brokerList, string consumerGroup) => new()
    {
        BootstrapServers = brokerList,
        GroupId = consumerGroup,

        // The loop owns when an offset moves, on both counts. Auto-commit would move it on
        // librdkafka's schedule, possibly before the branch was sent — inverting the one ordering
        // the design rests on — and auto-store would do the same a layer lower.
        EnableAutoCommit = false,
        EnableAutoOffsetStore = false,

        // The topic is seeded from outside the cluster, so a group reading it for the first time
        // must see paths written before the group existed. Latest would import nothing and report a
        // healthy Drained while doing it.
        AutoOffsetReset = AutoOffsetReset.Earliest,

        MaxPollIntervalMs = (int)MaxPollInterval.TotalMilliseconds,
    };
}
