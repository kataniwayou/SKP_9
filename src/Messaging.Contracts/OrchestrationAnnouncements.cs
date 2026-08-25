namespace Messaging.Contracts;

/// <summary>
/// L2 now holds this workflow. Published to <see cref="OrchestratorFanout.Exchange"/> by the API, once
/// its projection write has committed.
/// <para>
/// <b>It carries an id, not a definition, and that is load-bearing.</b> The recipient re-reads L2. A
/// message carrying the graph could be applied after a newer write had already landed, silently
/// reinstating a stale definition with nothing to detect it — and it would make the message a second
/// source of truth alongside the store the whole design says is the only one.
/// </para>
/// <para>
/// <b>Past tense, deliberately.</b> This is not a command to project something; the projection has
/// already happened. That is why it is published from the end of the projection handler and nowhere
/// else.
/// </para>
/// </summary>
public sealed record OrchestrationStarted(Guid WorkflowId) : IWorkflowScopedMessage;

/// <summary>
/// L2 no longer holds this workflow. Published once the API's clean has committed.
/// <para>
/// The recipient verifies the removal against L2 before acting on it — see the stop handler. It is not
/// responsible for the removal itself.
/// </para>
/// </summary>
public sealed record OrchestrationStopped(Guid WorkflowId) : IWorkflowScopedMessage;
