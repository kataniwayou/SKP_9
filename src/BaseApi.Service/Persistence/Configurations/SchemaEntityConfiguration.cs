using BaseApi.Service.Features.Schema;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BaseApi.Service.Persistence.Configurations;

/// <summary>
/// Configuration for <see cref="SchemaEntity"/>: the definition column is stored as Postgres
/// <c>json</c>, which checks the syntax and keeps the text as written — its property order is the
/// order a new assignment's payload is laid out in (the user, 2026-11-15; <c>jsonb</c> sorted the keys
/// by length). Everything else uses the mapping the base context infers — snake_case naming and the
/// <c>xmin</c> concurrency token.
/// </summary>
internal sealed class SchemaEntityConfiguration : IEntityTypeConfiguration<SchemaEntity>
{
    public void Configure(EntityTypeBuilder<SchemaEntity> entity)
    {
        entity.Property(e => e.Definition)
            .IsRequired()
            .HasColumnType("json");
    }
}
