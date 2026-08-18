namespace Messaging.Contracts;

/// <summary>
/// Control message: project this workflow definition into L2.
/// <para>
/// <b>The message carries the definition, not an id to go and fetch.</b> The consumer is the only
/// component that writes L2, so it cannot be asked to read L2 to discover what to write — that would
/// put a read on the critical path of a write whose whole purpose is to be the sole authority. The
/// API already holds the validated graph when it sends, so it sends the graph.
/// </para>
/// <para>
/// <b>No correlation id.</b> This message is produced and consumed inside one service and concerns
/// exactly one workflow, so <see cref="WorkflowL1.WorkflowId"/> is the correlation key. A separate id
/// would only distinguish two starts for the same workflow — and under override semantics those
/// converge on the same state, so there is nothing to distinguish.
/// </para>
/// </summary>
/// <param name="Workflow">The validated definition to project.</param>
public sealed record StartOrchestration(WorkflowL1 Workflow);
