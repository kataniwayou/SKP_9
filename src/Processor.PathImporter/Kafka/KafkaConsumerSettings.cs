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

    /// <summary>
    /// How long the broker waits for a heartbeat before declaring this consumer gone — and, because
    /// librdkafka holds its assignment locally until the same clock expires, <b>how long an outage
    /// reports <c>Drained</c> before it fails the step.</b>
    /// <para>
    /// Lowered from roughly 45s. A warm cached consumer that has lost its broker still answers
    /// "assigned" for the whole session timeout, so <c>WaitForAssignment</c> returns true, Consume
    /// finds nothing to read, and the dispatch reports a healthy-looking 0/N Drained. Measured at the
    /// default: two dispatches on a 30s cron reported Drained before the third failed the step with
    /// "no partition assigned". At 10s the first dispatch after an outage fails, on any schedule
    /// slower than that.
    /// </para>
    /// <para>
    /// <b>10s and not lower, because the broker enforces a floor.</b>
    /// <c>group.min.session.timeout.ms</c> defaults to 6s and is a broker setting we do not control —
    /// the org's may be higher. A value under the floor is not ignored: the join is rejected, which
    /// under the part-one rule fails the step on every single dispatch rather than none. 10s clears
    /// the common default with room, and the failure mode if some broker sets a higher floor is loud
    /// and immediate rather than silent.
    /// </para>
    /// <para>
    /// <c>HeartbeatIntervalMs</c> below is the constraint that comes with it. librdkafka requires the
    /// heartbeat to be shorter than the session timeout and the convention is a third; leaving the 3s
    /// default against a session timeout lowered further would drop healthy consumers on an ordinary
    /// scheduling delay. Lower this and that one moves with it.
    /// </para>
    /// </summary>
    public static readonly TimeSpan SessionTimeout = TimeSpan.FromSeconds(10);

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

        // The pair that decides how fast an outage becomes a failed step. See SessionTimeout above:
        // these two move together or not at all.
        SessionTimeoutMs = (int)SessionTimeout.TotalMilliseconds,
        HeartbeatIntervalMs = 3_000,
    };
}
