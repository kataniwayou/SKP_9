using BaseApi.Service.Features.Step;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BaseApi.Service.Persistence.Configurations;

/// <summary>
/// Configuration for the <see cref="StepNextSteps"/> junction: a composite key over both columns and
/// two self-referencing foreign keys to <see cref="StepEntity"/>, named explicitly to match the
/// convention the exception mapper parses.
/// <para>
/// <b>Both sides restrict on delete.</b> Deleting a step that a junction row references, as either
/// source or target, raises SQLSTATE 23001 and becomes a 422; the insert direction on the same
/// constraints raises 23503. Clearing the next-step collection through an update is what removes the
/// junction rows before the step itself can be deleted.
/// </para>
/// <para>
/// The relationships are declared without lambdas, so the foreign keys exist without navigation
/// properties appearing on the step entity.
/// </para>
/// </summary>
internal sealed class StepNextStepsConfiguration : IEntityTypeConfiguration<StepNextSteps>
{
    public void Configure(EntityTypeBuilder<StepNextSteps> entity)
    {
        entity.HasKey(e => new { e.StepId, e.NextStepId });

        entity.HasOne<StepEntity>()
            .WithMany()
            .HasForeignKey(e => e.StepId)
            .HasConstraintName("fk_step_next_steps_step_id")
            .OnDelete(DeleteBehavior.Restrict);

        entity.HasOne<StepEntity>()
            .WithMany()
            .HasForeignKey(e => e.NextStepId)
            .HasConstraintName("fk_step_next_steps_next_step_id")
            .OnDelete(DeleteBehavior.Restrict);
    }
}
