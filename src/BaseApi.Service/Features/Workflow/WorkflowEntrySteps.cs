namespace BaseApi.Service.Features.Workflow;

/// <summary>
/// Junction entity naming the steps a workflow starts at. <b>Deliberately not derived from
/// <c>BaseEntity</c></b> — junction rows have no id, no audit fields and no concurrency token, and
/// the model-building loop that adds the token filters on that base type, so junctions are excluded
/// naturally.
/// <para>
/// The composite key, the cascading foreign key to the workflow, and the restricting foreign key to
/// the step are configured in <c>WorkflowEntryStepsConfiguration</c>. The restrict on the step side
/// is load-bearing: it is what stops a step being deleted while a workflow still enters at it.
/// </para>
/// </summary>
public sealed class WorkflowEntrySteps
{
    public Guid WorkflowId { get; set; }
    public Guid StepId { get; set; }
}
