using BaseApi.Service.Features.Cache;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BaseApi.Service.Persistence.Configurations;

/// <summary>
/// Configuration for <see cref="CacheEntity"/>: the items column is stored as Postgres <c>jsonb</c>,
/// and the root carries a named unique index.
/// <para>
/// <b>The index name is <c>uq_cache_root</c>, not <c>uq_cache_entity_root</c>.</b> The exception
/// mapper resolves the offending column by stripping a <c>{kind}_{owner}_</c> prefix, where the
/// owner is the table name — <c>caches</c>, from the <c>DbSet</c> — tried exactly and then
/// s-stripped to <c>cache</c>. The entity-bearing spelling would leave <c>entity_root</c> as the
/// column name in the 409 body.
/// </para>
/// </summary>
internal sealed class CacheEntityConfiguration : IEntityTypeConfiguration<CacheEntity>
{
    public void Configure(EntityTypeBuilder<CacheEntity> entity)
    {
        entity.Property(e => e.Items)
            .IsRequired()
            .HasColumnType("jsonb");

        // A generous upper bound for a key prefix, and documentation that this is not an unbounded
        // text column.
        entity.Property(e => e.Root)
            .IsRequired()
            .HasMaxLength(200);

        // One dictionary per root. The root appears verbatim inside the L2 address, so two rows
        // sharing one would have the second write silently overwrite the first.
        entity.HasIndex(e => e.Root)
            .IsUnique()
            .HasDatabaseName("uq_cache_root");
    }
}
