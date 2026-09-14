using BaseApi.Service.Features.Cache;
using BaseApi.Service.Features.Workflow;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BaseApi.Service.Persistence.Configurations;

/// <summary>
/// Configuration for <see cref="WorkflowCaches"/>, mirroring <c>WorkflowAssignmentsConfiguration</c>.
/// <para>
/// The workflow side cascades, so deleting a workflow removes its junction rows; the cache side
/// restricts, so deleting a cache a workflow still names raises SQLSTATE 23001 and becomes a 422
/// rather than silently unbinding a projection that may be live.
/// </para>
/// </summary>
internal sealed class WorkflowCachesConfiguration : IEntityTypeConfiguration<WorkflowCaches>
{
    public void Configure(EntityTypeBuilder<WorkflowCaches> entity)
    {
        entity.HasKey(e => new { e.WorkflowId, e.CacheId });

        entity.HasOne<WorkflowEntity>()
            .WithMany()
            .HasForeignKey(e => e.WorkflowId)
            .HasConstraintName("fk_workflow_caches_workflow_id")
            .OnDelete(DeleteBehavior.Cascade);

        entity.HasOne<CacheEntity>()
            .WithMany()
            .HasForeignKey(e => e.CacheId)
            .HasConstraintName("fk_workflow_caches_cache_id")
            .OnDelete(DeleteBehavior.Restrict);
    }
}
