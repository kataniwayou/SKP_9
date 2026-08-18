namespace BaseApi.Service.Features.Workflow;

/// <summary>
/// Junction entity linking a workflow to the assignments it includes. <b>Deliberately not derived
/// from <c>BaseEntity</c></b> — junction rows have no id, no audit fields and no concurrency token.
/// <para>
/// The composite key, the cascading foreign key to the workflow, and the restricting foreign key to
/// the assignment are configured in <c>WorkflowAssignmentsConfiguration</c>.
/// </para>
/// </summary>
public sealed class WorkflowAssignments
{
    public Guid WorkflowId { get; set; }
    public Guid AssignmentId { get; set; }
}
