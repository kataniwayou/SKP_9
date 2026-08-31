namespace Messaging.Contracts;

/// <summary>
/// Single source of truth for the orchestrator queue and exchange names, shared between the side that
/// declares the topology and the side that addresses it.
/// <para>
/// <b>Start and stop share one queue, and that is the ordering guarantee.</b> Two queues would be
/// consumed independently, so a stop could be handled before the start it follows — leaving a
/// workflow projected into L2 that the operator believes they removed, with nothing to correct it
/// until the next start. One queue consumed one message at a time makes that unrepresentable.
/// </para>
/// <para>
/// Bare short-names, with no scheme prefix: a send addresses a queue by publishing to the default
/// exchange with the queue name as the routing key, so these strings are routing keys as written.
/// </para>
/// </summary>
public static class OrchestratorQueues
{
    /// <summary>
    /// The durable control queue carrying both start and stop. Declared with a dead-letter exchange
    /// and <b>with <c>x-delivery-limit</c> set explicitly to -1, meaning unlimited</b>: a delivery
    /// limit counts every redelivery, including the requeues issued while the projection store is
    /// unreachable, so a limit would dead-letter a start that was never malformed once an outage ran
    /// long enough. Poison messages are parked by the consumer on their first delivery, which is what
    /// a limit would otherwise be protecting against.
    /// <para>
    /// <b>The argument is stated rather than omitted, and the difference is not cosmetic.</b> This
    /// queue carried no such argument until it was found that RabbitMQ 4.x applies a default
    /// delivery-limit of 20 to every quorum queue declaring none — so the omission did not mean "no
    /// limit", it meant twenty, with nothing in the source saying so. Twenty requeue cycles is well
    /// inside a Redis outage this design is built to ride out.
    /// </para>
    /// </summary>
    public const string Control = "orchestrator-control";

    /// <summary>
    /// Where <see cref="Control"/> parks a message it refuses. Bound to <see cref="DeadLetterExchange"/>
    /// under the <see cref="Control"/> routing key.
    /// </summary>
    public const string ControlDead = "orchestrator-control.dead";

    /// <summary>
    /// The dead-letter exchange named by <see cref="Control"/>'s <c>x-dead-letter-exchange</c>
    /// argument.
    /// <para>
    /// <b>It must be declared before the queue that names it.</b> The argument is not validated at
    /// declare time, so a queue pointing at an exchange that does not exist is accepted — and every
    /// message it parks is discarded silently, which turns "a parked message is recoverable" into a
    /// false statement with no error anywhere to contradict it.
    /// </para>
    /// </summary>
    public const string DeadLetterExchange = "orchestrator-dlx";

    /// <summary>
    /// Shared competing-consumer result queue, carrying every <see cref="StepOutcome"/> a processor
    /// reports. Stored as a bare endpoint short-name.
    /// <para>
    /// <b>Shared across replicas, and deliberately not leader-gated.</b> Leadership fences cron fires,
    /// where two replicas firing one schedule would double-dispatch. A result is caused work rather
    /// than initiated work: exactly one exists per step that ran, and whichever replica takes it does
    /// the whole hand-off. Gating this on leadership would idle every follower and make the leader the
    /// throughput ceiling for the entire deployment.
    /// </para>
    /// </summary>
    public const string Result = "orchestrator-result";

    /// <summary>Where <see cref="Result"/> parks a message it refuses.</summary>
    public const string ResultDead = "orchestrator-result.dead";

    /// <summary>
    /// Pre-to-post fan-out queue. The pre stage sends one <see cref="NextStepHandoff"/> per matched
    /// successor here, and the post consumer writes that successor's input key and dispatches it.
    /// <para>
    /// <b>A separate hop rather than dispatching inline, because a fan-out is N sends that must not
    /// half-happen.</b> Dispatching successors directly from the pre hop would leave a failure after
    /// the second of three sends with no way to finish: the source blob is still there, so the retry
    /// re-sends all three, and the two that already landed run twice. Splitting at the queue makes
    /// each successor its own delivery with its own retry, and leaves the pre hop with a single
    /// idempotent job — copy the blob out, hand off, reclaim.
    /// </para>
    /// </summary>
    public const string ResultPost = "orchestrator-result-post";

    /// <summary>Where <see cref="ResultPost"/> parks a message it refuses.</summary>
    public const string ResultPostDead = "orchestrator-result-post.dead";
}
