namespace BaseApi.Service.Features.Workflow;

/// <summary>
/// Junction row binding a workflow to one cache dictionary it projects on start.
/// <para>
/// Like the other two junctions it deliberately does not derive from <c>BaseEntity</c>, which is
/// what keeps it out of the <c>xmin</c> shadow-property loop in
/// <c>BaseDbContext.OnModelCreating</c>.
/// </para>
/// <para>
/// The column is <c>CacheId</c>, not <c>CacheEntityId</c>, matching how <c>WorkflowAssignments</c>
/// names <c>AssignmentEntity</c> as <c>AssignmentId</c> — the exception mapper strips the owner
/// prefix from the constraint name, so the convention has to hold for the 422 body to name a column
/// that exists.
/// </para>
/// </summary>
public sealed class WorkflowCaches
{
    public Guid WorkflowId { get; set; }

    public Guid CacheId { get; set; }
}
