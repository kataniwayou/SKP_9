namespace Messaging.Contracts;

/// <summary>
/// Orchestrator to processor: run one step. Sent to <see cref="ProcessorQueues.Work"/>.
/// <para>
/// <b>There is no message id, deliberately.</b> The pre hop's one store mutation is deleting
/// <see cref="EntryId"/> once the author returns, and that key already rides the body — nothing here
/// needs a minted identity of its own to be stable about. The identity that matters is minted when the
/// author sends to post, where it becomes an L2 key.
/// </para>
/// <para>
/// <see cref="EntryId"/> is the L2 key holding this step's input, or <see cref="Guid.Empty"/> for a
/// source step, which has no upstream input and produces its own. <see cref="Payload"/> is the step's
/// processor config as JSON, already validated against the config schema when the workflow was
/// created.
/// </para>
/// <para>
/// <b>The parameter order is the canonical one, shared by every record in this file and by
/// <see cref="ExecutionLogScope.BuildScope(Guid,Guid,Guid,Guid,Guid)"/>:</b> correlation, execution,
/// workflow, step, processor, then the hop's own fields. It runs broadest scope to narrowest — a
/// correlation spans a fire, an execution spans a lineage, workflow/step/processor fix the position,
/// and the entry id names this one hop. Every id is positional rather than an init property so that
/// re-ordering them can never compile: these are all <see cref="Guid"/>, and a transposition among
/// init properties would be accepted by the compiler and wrong at runtime.
/// </para>
/// </summary>
public sealed record ProcessDispatch(
    Guid CorrelationId,
    Guid ExecutionId,
    Guid WorkflowId,
    Guid StepId,
    Guid ProcessorId,
    string Payload,
    Guid EntryId);

/// <summary>
/// Processor to itself: one branch of output, ready to be validated, persisted and reported.
/// <para>
/// <b><see cref="EntryId"/> is minted here and rides the body, and that is what makes redelivery
/// safe.</b> RabbitMQ never assigns a message id — the AMQP property is producer-set — so a body field
/// is the only carrier that survives a NACK-requeue byte-identical. The post handler writes to the key
/// this id names, which turns a replayed delivery of <i>this</i> message into a rewrite of the same
/// bytes rather than a second blob.
/// </para>
/// <para>
/// <b>It is the successor's input key, not this step's.</b> One blob under one key: the post handler
/// writes it and hands the same id to the orchestrator as <see cref="StepOutcome.EntryId"/>, which
/// hands it on unchanged to a single successor. So the name <c>EntryId</c> means the input key of
/// whichever step the record is about, and which step that is changes at this boundary — on a
/// <see cref="ProcessDispatch"/> it is the step being run, here it is the step that comes next.
/// </para>
/// <para>
/// <b>The step's own input id is not carried.</b> It was only ever here for the log scope; the pre
/// handler reclaims that key itself once the author's transform returns, and nothing on this hop
/// reads it. A branch is traced back to its input by joining to the pre-hop record on
/// (<see cref="CorrelationId"/>, <see cref="StepId"/>), which is exact except where a step is entered
/// more than once in one fire.
/// </para>
/// </summary>
public sealed record ProcessedData(
    Guid CorrelationId,
    Guid ExecutionId,
    Guid WorkflowId,
    Guid StepId,
    Guid ProcessorId,
    Guid EntryId,
    byte[] Data);

/// <summary>
/// Processor to orchestrator: how one step ended. One message for all three terminals, discriminated
/// by <see cref="Result"/>.
/// <para>
/// <b>One record rather than three, because the orchestrator's question is a value comparison.</b>
/// Advancement matches a successor's entry condition against <c>(int)Result</c>; three record types
/// would mean three handler registrations, three near-identical classes, and a mapping from type back
/// to int at the top of each one. The discriminator belongs in the message.
/// </para>
/// <para>
/// <b><see cref="EntryId"/> names whichever key is now the orchestrator's to deal with, and which key
/// that is depends on <see cref="Result"/>.</b> On <see cref="StepResult.Completed"/> it is the output
/// blob, which the orchestrator relocates to the successors and then reclaims. On
/// <see cref="StepResult.Failed"/> and <see cref="StepResult.Cancelled"/> there is no output — it is
/// the step's own <i>input</i>, which is still in the store because the pre handler only reclaims an
/// input whose author returned normally. Nothing else will ever come for that key: execution blobs
/// carry no TTL and no sweeper covers them, so if this field did not name it, every failed step would
/// leak its input permanently.
/// </para>
/// <para>
/// <b>No diagnostic text, deliberately.</b> The orchestrator branches on <see cref="Result"/> and
/// nothing else, so an error string on the wire would be a field written and never read — and a
/// framework exception's message is actively unsafe to put here, since a deserialize
/// <c>JsonException</c> quotes the offending fragment of the payload. The reason a step failed is
/// logged by the processor that failed it, under this record's ids, and is found by joining on them.
/// </para>
/// </summary>
public sealed record StepOutcome(
    Guid CorrelationId,
    Guid ExecutionId,
    Guid WorkflowId,
    Guid StepId,
    Guid ProcessorId,
    Guid EntryId,
    StepResult Result);
