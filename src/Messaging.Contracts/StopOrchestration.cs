namespace Messaging.Contracts;

/// <summary>
/// Control message: remove this workflow's projection from L2.
/// <para>
/// <b>An id is sufficient here where a definition was necessary for start, and the asymmetry is
/// real.</b> The clean has to delete the keys that are actually present, which is the <i>previous</i>
/// graph — a definition sent now would describe the wrong key set whenever the stored graph differs
/// from the caller's view. So the consumer discovers the key set by reading the stored root and
/// walking it, and needs nothing from the sender but the identity.
/// </para>
/// <para>
/// A stop for a workflow with no stored root is a no-op, not an error: the desired end state already
/// holds. That is what makes repeated stops safe.
/// </para>
/// </summary>
/// <param name="WorkflowId">The workflow whose projection is to be removed.</param>
public sealed record StopOrchestration(Guid WorkflowId) : IWorkflowScopedMessage;
