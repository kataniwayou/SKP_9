using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Schema;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BaseApi.Service.Persistence.Configurations;

/// <summary>
/// Configuration for <see cref="ProcessorEntity"/>. The explicit index and constraint names here are
/// load-bearing: they follow the convention the exception mapper parses to recover the offending
/// column, so a duplicate reports a 409 naming the field. EF's auto-generated names would not match,
/// and the mapper would then report no field at all.
/// <para>
/// <b>Uniqueness is one row per <c>(SourceHash, InstanceId)</c>, counting "no instance" as a value.</b>
/// That is two partial indexes rather than one composite, and the reason is the exception mapper.
/// It recovers the column by stripping the <c>uq_&lt;table&gt;_</c> prefix off the constraint name,
/// so a composite named <c>uq_processor_source_hash_instance_id</c> would strip to
/// <c>source_hash_instance_id</c> — a string that passes the mapper's snake_case sanity check while
/// naming no column and no DTO field. Splitting the rule gives each half a name that is already the
/// field the caller has to change, and it sidesteps <c>NULLS NOT DISTINCT</c> entirely: the filters
/// partition the table on <c>instance_id IS NULL</c>, so the two NULLs Postgres would otherwise treat
/// as distinct are compared by the first index on <c>source_hash</c> alone.
/// </para>
/// <para>
/// <c>uq_processor_source_hash</c> keeps the name it has always had, and on the rows it still covers
/// — the ones with no instance id — it means exactly what it used to. A processor registered the way
/// every processor is registered today collides the same way and reports the same field.
/// </para>
/// <para>
/// The three schema foreign keys restrict on delete, matching the step, assignment and junction
/// foreign keys: a schema still referenced by a processor cannot be deleted, and the attempt raises
/// SQLSTATE 23001 which the mapper turns into a 422 naming the offending column.
/// </para>
/// <para>
/// They previously nulled the column instead. That made a schema delete succeed while silently
/// stripping the contract off every processor pointing at it — the processor kept running with no
/// input, output or config schema, and nothing surfaced to the caller who deleted it. Restricting
/// makes the reference say so.
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
        // One shared row per build. Partial, so it constrains only the rows that claim no instance
        // id; a StatefulSet's per-replica rows are outside it and may share a hash freely.
        entity.HasIndex(e => e.SourceHash)
            .IsUnique()
            .HasFilter("instance_id IS NULL")
            .HasDatabaseName("uq_processor_source_hash");

        // One row per replica per build. Leads with source_hash so it also serves the identity
        // lookup, which always filters on the hash first and the instance id second.
        entity.HasIndex(e => new { e.SourceHash, e.InstanceId })
            .IsUnique()
            .HasFilter("instance_id IS NOT NULL")
            .HasDatabaseName("uq_processor_instance_id");

        entity.HasOne<SchemaEntity>()
            .WithMany()
            .HasForeignKey(e => e.InputSchemaId)
            .HasConstraintName("fk_processor_input_schema_id")
            .OnDelete(DeleteBehavior.Restrict);

        entity.HasOne<SchemaEntity>()
            .WithMany()
            .HasForeignKey(e => e.OutputSchemaId)
            .HasConstraintName("fk_processor_output_schema_id")
            .OnDelete(DeleteBehavior.Restrict);

        entity.HasOne<SchemaEntity>()
            .WithMany()
            .HasForeignKey(e => e.ConfigSchemaId)
            .HasConstraintName("fk_processor_config_schema_id")
            .OnDelete(DeleteBehavior.Restrict);

        // A SHA-256 hex string is exactly 64 characters; lock that at the database too.
        entity.Property(e => e.SourceHash)
            .IsRequired()
            .HasMaxLength(64);

        // Long enough for any Kubernetes object name (253 is the DNS-subdomain ceiling, but a pod
        // name that long cannot exist: the StatefulSet name plus its ordinal suffix must fit inside
        // it). Nullable, and blank is normalized to null on the entity before it reaches here.
        entity.Property(e => e.InstanceId)
            .HasMaxLength(200);
    }
}
