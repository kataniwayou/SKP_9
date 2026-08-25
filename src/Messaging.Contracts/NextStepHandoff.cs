namespace Messaging.Contracts;

/// <summary>
/// Orchestrator to orchestrator: one resolved successor, ready to be given its own input key and
/// dispatched. Sent to <see cref="OrchestratorQueues.ResultPost"/>, one per matched successor.
/// <para>
/// <b>Every field describes the NEXT step, not the one that just finished.</b> <see cref="StepId"/>,
/// <see cref="ProcessorId"/> and <see cref="Payload"/> come from the successor's L1 entry, and
/// <see cref="EntryId"/> is a key that does not exist yet — the post hop writes it. Only
/// <see cref="CorrelationId"/>, <see cref="ExecutionId"/> and <see cref="WorkflowId"/> are threaded
/// through from the outcome that caused this hand-off.
/// </para>
/// <para>
/// <b>The whole message is self-contained, and that is what lets the post hop touch no L1 at all.</b>
/// Result and hand-off are consumed from shared queues, so the two hops can land on different
/// replicas whose L1 mirrors differ. Re-resolving the successor on the far side would mean routing
/// decided from one snapshot and payload read from another — a step dispatched with a payload from a
/// different version of the workflow, with nothing to show that had happened.
/// </para>
/// <para>
/// <b><see cref="Data"/> rides inline, and it is a copy.</b> A step with several successors cannot
/// hand them all one blob: the first successor's pre hop reclaims that key when its author returns,
/// and the others would find it absent. So the pre hop reads the source blob ONCE, before any
/// hand-off is sent, and each successor is given its own copy under its own <see cref="EntryId"/>.
/// It is <see cref="Array.Empty{T}"/> when the finished step produced no output — a failure, a
/// cancellation, or a source step — in which case the successor is dispatched with
/// <see cref="Guid.Empty"/> and produces its own input, exactly as an entry step does.
/// </para>
/// </summary>
public sealed record NextStepHandoff(
    Guid CorrelationId,
    Guid ExecutionId,
    Guid WorkflowId,
    Guid StepId,
    Guid ProcessorId,
    string Payload,
    Guid EntryId,
    byte[] Data) : IExecutionMessage;
