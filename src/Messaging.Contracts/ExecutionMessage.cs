namespace Messaging.Contracts;

/// <summary>
/// A message that names the workflow it belongs to. The narrow half of the pair, because the
/// control plane genuinely has nothing else to say: a start or a stop is about a workflow and not
/// about any run of one.
/// </summary>
public interface IWorkflowScopedMessage
{
    Guid WorkflowId { get; }
}

/// <summary>
/// A message that carries the full execution identity — the five ids every pipeline hop already has
/// as positional parameters, plus the workflow id it inherits.
/// <para>
/// <b>This exists so the SENDER can stamp those ids onto the wire without knowing the contract.</b>
/// <c>IQueueSender.SendAsync&lt;T&gt;</c> is generic and <c>BuildProperties</c> never saw the body, so
/// every id lived only inside the serialized JSON. That is invisible to anything that has not
/// deserialized the message — including the consumer's own catch block, which is where a park is
/// logged. See <see cref="MessageIdHeaders"/> for what that cost.
/// </para>
/// <para>
/// <b>Implemented by declaration only.</b> Every member here is already a positional parameter with
/// exactly this name on every implementing record, so a record satisfies the interface by naming it
/// and nothing else changes — no constructor moves, no call site edits, and no new field on the
/// wire. That is why the member names are not up for adjustment: renaming one here silently stops a
/// record implementing it, and the compiler's error will point at the record rather than at this
/// decision.
/// </para>
/// </summary>
public interface IExecutionMessage : IWorkflowScopedMessage
{
    Guid CorrelationId { get; }
    Guid ExecutionId { get; }
    Guid StepId { get; }
    Guid ProcessorId { get; }
    Guid EntryId { get; }
}
