namespace Messaging.Contracts;

/// <summary>
/// The L1 workflow definition as it travels to the start consumer: the validated graph, flattened,
/// carrying everything the L2 write needs and nothing else.
/// <para>
/// <b>This is the API's in-memory graph minus the reference data the write does not read.</b> The
/// API's snapshot also holds processors and schemas, but those exist to feed the validators — the
/// projection write never touches them. Shipping them would put data on the wire that no consumer
/// reads, and would make every processor or schema edit look like a change to the workflow contract.
/// </para>
/// <para>
/// <b>The assignment payload is resolved by the API, not the consumer.</b> A step's payload lives on
/// an assignment bound to that step, and the API holds both sides of that binding while it holds the
/// snapshot. Flattening it here means the consumer never has to reason about the junction, and an
/// unbound step — a valid shape, since a workflow may carry steps with no payload binding — arrives
/// with an empty payload rather than a null the consumer must guard.
/// </para>
/// <para>
/// <b><see cref="Cron"/> is nullable and null means unscheduled.</b> The start path does not reject a
/// null cron: an unscheduled workflow is still a valid projection, and the decision about whether it
/// can be scheduled belongs to whoever later reads the root, not to the write.
/// </para>
/// </summary>
/// <param name="WorkflowId">The workflow this definition is for. Also the L2 root key's identity.</param>
/// <param name="EntryStepIds">The steps a fire begins from. The BFS that discovers this graph's key
/// set on a later clean walks outward from exactly these.</param>
/// <param name="Cron">The five-field cron expression, or null when the workflow is not scheduled.</param>
/// <param name="Steps">Every step in the validated graph, one entry per L2 step key to be written.</param>
public sealed record WorkflowL1(
    Guid WorkflowId,
    List<Guid> EntryStepIds,
    string? Cron,
    List<StepL1> Steps);

/// <summary>
/// One step of a <see cref="WorkflowL1"/> — the flat projection of a step plus its resolved payload
/// binding, mapping one-to-one onto a single L2 step key.
/// </summary>
/// <param name="StepId">Identity of the step; the second half of its L2 key.</param>
/// <param name="EntryCondition">The step's entry condition as its underlying integer. Sent as an int
/// rather than the API's enum so the contracts leaf stays free of the entity assembly, and so the
/// wire value cannot shift if the enum's members are ever reordered.</param>
/// <param name="ProcessorId">The processor that executes this step.</param>
/// <param name="Payload">The bound assignment's payload, or empty when the step has no binding.</param>
/// <param name="NextStepIds">Successors, which are also the BFS edges a later clean follows.</param>
public sealed record StepL1(
    Guid StepId,
    int EntryCondition,
    Guid ProcessorId,
    string Payload,
    List<Guid> NextStepIds);
