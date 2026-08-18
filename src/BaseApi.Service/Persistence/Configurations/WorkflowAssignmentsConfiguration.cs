using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Workflow;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BaseApi.Service.Persistence.Configurations;

/// <summary>
/// Configuration for the <see cref="WorkflowAssignments"/> junction, mirroring the entry-step one: a
/// composite key over both columns and two foreign keys named to match the convention the exception
/// mapper parses.
/// <para>
/// The delete behaviour is asymmetric for the same reason: the workflow side cascades, because the
/// workflow owns the junction lifecycle, while the assignment side restricts, so deleting an
/// assignment a workflow still references raises SQLSTATE 23001 and becomes a 422. The insert
/// direction on that constraint raises 23503.
/// </para>
/// </summary>
internal sealed class WorkflowAssignmentsConfiguration : IEntityTypeConfiguration<WorkflowAssignments>
{
    public void Configure(EntityTypeBuilder<WorkflowAssignments> entity)
    {
        entity.HasKey(e => new { e.WorkflowId, e.AssignmentId });

        entity.HasOne<WorkflowEntity>()
            .WithMany()
            .HasForeignKey(e => e.WorkflowId)
            .HasConstraintName("fk_workflow_assignments_workflow_id")
            .OnDelete(DeleteBehavior.Cascade);

        entity.HasOne<AssignmentEntity>()
            .WithMany()
            .HasForeignKey(e => e.AssignmentId)
            .HasConstraintName("fk_workflow_assignments_assignment_id")
            .OnDelete(DeleteBehavior.Restrict);
    }
}
