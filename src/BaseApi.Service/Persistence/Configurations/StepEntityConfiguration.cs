using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Step;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BaseApi.Service.Persistence.Configurations;

/// <summary>
/// Configuration for <see cref="StepEntity"/>: a non-nullable foreign key to
/// <see cref="ProcessorEntity"/>, named explicitly to match the
/// <c>fk_&lt;owner&gt;_&lt;column&gt;</c> convention the exception mapper parses.
/// <para>
/// The delete behaviour restricts, so deleting a processor while a step references it raises
/// SQLSTATE 23001 and becomes a 422. The insert direction on the same constraint — a step naming a
/// processor that does not exist — raises 23503.
/// </para>
/// <para>
/// <c>EntryCondition</c> keeps its default int mapping, with no value conversion, which is what
/// preserves the enum's numeric values across migrations.
/// </para>
/// </summary>
internal sealed class StepEntityConfiguration : IEntityTypeConfiguration<StepEntity>
{
    public void Configure(EntityTypeBuilder<StepEntity> entity)
    {
        entity.HasOne<ProcessorEntity>()
            .WithMany()
            .HasForeignKey(e => e.ProcessorId)
            .HasConstraintName("fk_step_processor_id")
            .OnDelete(DeleteBehavior.Restrict);

        entity.Property(e => e.EntryCondition)
            .IsRequired();
    }
}
