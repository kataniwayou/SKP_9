using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BaseApi.Service.Persistence.Configurations;

/// <summary>
/// Configuration for the <see cref="WorkflowEntrySteps"/> junction: a composite key over both
/// columns and two foreign keys, named explicitly to match the convention the exception mapper
/// parses. The owner segment here is a multi-underscore table name, which the mapper resolves by
/// anchoring on the table reported with the error rather than by splitting the constraint name.
/// <para>
/// <b>The two sides behave differently on delete, deliberately:</b>
/// <list type="bullet">
///   <item><b>Workflow side cascades</b> — the workflow owns the junction lifecycle, so deleting it
///     removes its entry-step rows implicitly.</item>
///   <item><b>Step side restricts</b> — deleting a step a workflow still enters at raises SQLSTATE
///     23001 and becomes a 422. The reference has to be removed, or the workflow deleted, first.
///     The insert direction on the same constraint raises 23503.</item>
/// </list>
/// </para>
/// <para>
/// The relationships are declared without lambdas, so the foreign keys exist without navigation
/// properties appearing on either principal.
/// </para>
/// </summary>
internal sealed class WorkflowEntryStepsConfiguration : IEntityTypeConfiguration<WorkflowEntrySteps>
{
    public void Configure(EntityTypeBuilder<WorkflowEntrySteps> entity)
    {
        entity.HasKey(e => new { e.WorkflowId, e.StepId });

        entity.HasOne<WorkflowEntity>()
            .WithMany()
            .HasForeignKey(e => e.WorkflowId)
            .HasConstraintName("fk_workflow_entry_steps_workflow_id")
            .OnDelete(DeleteBehavior.Cascade);

        entity.HasOne<StepEntity>()
            .WithMany()
            .HasForeignKey(e => e.StepId)
            .HasConstraintName("fk_workflow_entry_steps_step_id")
            .OnDelete(DeleteBehavior.Restrict);
    }
}
