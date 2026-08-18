using BaseApi.Service.Features.Schema;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BaseApi.Service.Persistence.Configurations;

/// <summary>
/// Configuration for <see cref="SchemaEntity"/>: the definition column is stored as Postgres
/// <c>jsonb</c>, so it is compact and indexable. Everything else uses the mapping the base context
/// infers — snake_case naming and the <c>xmin</c> concurrency token.
/// </summary>
internal sealed class SchemaEntityConfiguration : IEntityTypeConfiguration<SchemaEntity>
{
    public void Configure(EntityTypeBuilder<SchemaEntity> entity)
    {
        entity.Property(e => e.Definition)
            .IsRequired()
            .HasColumnType("jsonb");
    }
}
