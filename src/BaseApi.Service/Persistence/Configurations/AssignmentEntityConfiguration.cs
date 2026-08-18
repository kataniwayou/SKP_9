using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Step;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BaseApi.Service.Persistence.Configurations;

/// <summary>
/// Configuration for <see cref="AssignmentEntity"/>: the payload column is stored as Postgres
/// <c>jsonb</c>, and there is one non-nullable foreign key to <see cref="StepEntity"/>.
/// <para>
/// The delete behaviour restricts, so deleting a step an assignment references raises SQLSTATE
/// 23001 and becomes a 422; the insert direction raises 23503.
/// </para>
/// <para>
/// The constraint name is explicit rather than EF-generated, because the exception mapper resolves
/// the offending column by stripping the owner prefix from the constraint name. An auto-generated
/// name would not match the convention, and the mapper would then report no field name at all.
/// </para>
/// <para>
/// The relationship is declared without lambdas, which creates the foreign key without generating
/// navigation properties on either entity.
/// </para>
/// </summary>
internal sealed class AssignmentEntityConfiguration : IEntityTypeConfiguration<AssignmentEntity>
{
    public void Configure(EntityTypeBuilder<AssignmentEntity> entity)
    {
        entity.Property(e => e.Payload)
            .IsRequired()
            .HasColumnType("jsonb");

        entity.HasOne<StepEntity>()
            .WithMany()
            .HasForeignKey(e => e.StepId)
            .HasConstraintName("fk_assignment_step_id")
            .OnDelete(DeleteBehavior.Restrict);
    }
}
