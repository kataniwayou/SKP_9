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
    /// and <b>deliberately without <c>x-delivery-limit</c></b>: a delivery limit counts every
    /// redelivery, including the requeues issued while the projection store is unreachable, so a long
    /// outage would dead-letter a start that was never malformed. Poison messages are parked by the
    /// consumer on their first delivery, which is what a limit would otherwise be protecting against.
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
    /// Shared competing-consumer result queue. Stored as a bare endpoint short-name.
    /// </summary>
    public const string Result = "orchestrator-result";

    /// <summary>
    /// Pre-to-post fan-out queue. The pre stage sends one <c>NextStepHandoff</c> per fan-out target
    /// here and the post consumer relocates the data and dispatches.
    /// </summary>
    public const string ResultPost = "orchestrator-result-post";
}
