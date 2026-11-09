namespace Processor.Napole;

/// <summary>
/// What Elasticsearch shows of one traced execution across a tick's trail span, for one section (reach
/// spec §4): step-outcome counts only, read from the orchestrator's outcome records. Everything but
/// <see cref="Roots"/> counts step runs at or after the execution's first <c>fromStepId</c> outcome.
/// </summary>
/// <param name="Roots"><c>OutcomeTemplates.EntryCompleted</c> records; more than 1 is a re-import of the id.</param>
/// <param name="Reached">step runs of <c>toStepId</c>: 2 when two branches arrive there.</param>
/// <param name="EndCompleted">outcomes at <c>toStepId</c> that are Completed.</param>
/// <param name="EndFailed">outcomes at <c>toStepId</c> that are Failed.</param>
/// <param name="EndCancelled">outcomes at <c>toStepId</c> that are Cancelled.</param>
/// <param name="WayFailed">Failed outcomes at any step.</param>
/// <param name="WayCancelled">Cancelled outcomes at any step.</param>
public sealed record ExecutionTrail(
    Guid ExecutionId,
    long Roots,
    long Reached,
    long EndCompleted,
    long EndFailed,
    long EndCancelled,
    long WayFailed,
    long WayCancelled);
