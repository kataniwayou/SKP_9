using BaseApi.Service.Features.Cache;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BaseApi.Service.Persistence.Configurations;

/// <summary>
/// Configuration for <see cref="CacheItem"/>: keyed by (cache, key), so one value per key per dictionary
/// even for a write that skips the validator; deleted with its cache.
/// </summary>
internal sealed class CacheItemConfiguration : IEntityTypeConfiguration<CacheItem>
{
    public void Configure(EntityTypeBuilder<CacheItem> entity)
    {
        entity.HasKey(e => new { e.CacheId, e.Key });

        entity.Property(e => e.Key)
            .IsRequired()
            .HasMaxLength(CacheRules.MaxKeyLength);

        entity.Property(e => e.Value)
            .IsRequired()
            .HasColumnType("text");

        entity.HasOne<CacheEntity>()
            .WithMany(c => c.Items)
            .HasForeignKey(e => e.CacheId)
            .HasConstraintName("fk_cache_items_cache_id")
            .OnDelete(DeleteBehavior.Cascade);
    }
}
