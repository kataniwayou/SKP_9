namespace Messaging.Contracts;

/// <summary>
/// Orchestrator to processor: run one step. Sent to <see cref="ProcessorQueues.Work"/>.
/// <para>
/// <b>There is no message id, deliberately.</b> The pre hop needs no delivery identity of its own —
/// it writes nothing and reclaims nothing, so there is no key to be stable about. The identity that
/// matters is minted when the author sends to post, where it becomes an L2 key.
/// </para>
/// <para>
/// <see cref="EntryId"/> is the L2 key holding this step's input, or <see cref="Guid.Empty"/> for a
/// source step, which has no upstream input and produces its own. <see cref="Payload"/> is the step's
/// processor config as JSON, already validated against the config schema when the workflow was
/// created.
/// </para>
/// </summary>
public sealed record ProcessDispatch(Guid WorkflowId, Guid StepId, Guid ProcessorId)
{
    public Guid CorrelationId { get; init; }
    public Guid ExecutionId   { get; init; }
    public Guid EntryId       { get; init; }
    public string Payload     { get; init; } = "";
}

/// <summary>
/// Processor to itself: one branch of output, ready to be validated, persisted and reported.
/// <para>
/// <b><see cref="MessageId"/> rides the body, and that is what makes redelivery safe.</b> RabbitMQ
/// never assigns a message id — the AMQP property is producer-set — so a body field is the only
/// carrier that survives a NACK-requeue byte-identical. The post handler writes to the key this id
/// names, which turns a replayed delivery into a rewrite of the same bytes rather than a second blob.
/// </para>
/// <para>
/// <see cref="EntryId"/> is the input key the post handler reclaims. It is carried here rather than
/// deleted by the pre handler because pre must leave the input intact for any redelivery of itself.
/// </para>
/// </summary>
public sealed record ProcessedData(Guid WorkflowId, Guid StepId, Guid ProcessorId)
{
    public Guid CorrelationId { get; init; }
    public Guid ExecutionId   { get; init; }
    public Guid MessageId     { get; init; }
    public Guid EntryId       { get; init; }
    public byte[] Data        { get; init; } = [];
}

/// <summary>
/// A step produced output. <see cref="EntryId"/> is the output key — the
/// <see cref="ProcessedData.MessageId"/> the post handler just wrote — which the orchestrator hands
/// straight through to a single successor's input, or copies into one key per successor when a step
/// fans out to more than one.
/// </summary>
public sealed record StepCompleted(Guid WorkflowId, Guid StepId, Guid ProcessorId)
{
    public Guid CorrelationId { get; init; }
    public Guid ExecutionId   { get; init; }
    public Guid EntryId       { get; init; }
}

/// <summary>
/// A step failed. No output key, so <see cref="EntryId"/> stays <see cref="Guid.Empty"/>.
/// <para>
/// <b><see cref="ErrorMessage"/> carries author text only.</b> A message the author wrote is
/// intentional and safe. A framework-caught exception's message is not: a deserialize
/// <c>JsonException</c> quotes the offending fragment of the payload — path, line, token — so putting
/// it here would leak payload content into the orchestrator's projections. Framework failures send a
/// fixed constant and log the detail locally.
/// </para>
/// </summary>
public sealed record StepFailed(Guid WorkflowId, Guid StepId, Guid ProcessorId)
{
    public Guid CorrelationId  { get; init; }
    public Guid ExecutionId    { get; init; }
    public Guid EntryId        { get; init; } = Guid.Empty;
    public string ErrorMessage { get; init; } = "";
}

/// <summary>
/// A step ended its branch and said so. Distinct from ending silently, which is also legitimate: this
/// exists for the case where a successor gated on a cancelled predecessor needs to know.
/// </summary>
public sealed record StepCancelled(Guid WorkflowId, Guid StepId, Guid ProcessorId)
{
    public Guid CorrelationId         { get; init; }
    public Guid ExecutionId           { get; init; }
    public Guid EntryId               { get; init; } = Guid.Empty;
    public string CancellationMessage { get; init; } = "";
}
