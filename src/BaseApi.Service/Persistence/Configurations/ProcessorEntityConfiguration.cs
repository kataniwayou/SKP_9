using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Schema;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BaseApi.Service.Persistence.Configurations;

/// <summary>
/// Configuration for <see cref="ProcessorEntity"/>. The explicit index and constraint names here are
/// load-bearing: they follow the convention the exception mapper parses to recover the offending
/// column, so a duplicate source hash reports a 409 naming the field. EF's auto-generated names
/// would not match, and the mapper would then report no field at all.
/// <para>
/// The three schema foreign keys null the column on delete rather than restricting, so deleting a
/// referenced schema succeeds by design instead of raising the restrict violation that the step,
/// assignment and junction foreign keys produce.
/// </para>
/// <para>
/// The relationships are declared without lambdas, which creates the foreign keys without generating
/// navigation properties between entities.
/// </para>
/// </summary>
internal sealed class ProcessorEntityConfiguration : IEntityTypeConfiguration<ProcessorEntity>
{
    public void Configure(EntityTypeBuilder<ProcessorEntity> entity)
    {
        entity.HasIndex(e => e.SourceHash)
            .IsUnique()
            .HasDatabaseName("uq_processor_source_hash");

        entity.HasOne<SchemaEntity>()
            .WithMany()
            .HasForeignKey(e => e.InputSchemaId)
            .HasConstraintName("fk_processor_input_schema_id")
            .OnDelete(DeleteBehavior.SetNull);

        entity.HasOne<SchemaEntity>()
            .WithMany()
            .HasForeignKey(e => e.OutputSchemaId)
            .HasConstraintName("fk_processor_output_schema_id")
            .OnDelete(DeleteBehavior.SetNull);

        entity.HasOne<SchemaEntity>()
            .WithMany()
            .HasForeignKey(e => e.ConfigSchemaId)
            .HasConstraintName("fk_processor_config_schema_id")
            .OnDelete(DeleteBehavior.SetNull);

        // A SHA-256 hex string is exactly 64 characters; lock that at the database too.
        entity.Property(e => e.SourceHash)
            .IsRequired()
            .HasMaxLength(64);
    }
}
