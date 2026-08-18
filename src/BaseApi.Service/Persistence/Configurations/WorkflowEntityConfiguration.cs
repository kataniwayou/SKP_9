using BaseApi.Service.Features.Workflow;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BaseApi.Service.Persistence.Configurations;

/// <summary>
/// Configuration for <see cref="WorkflowEntity"/>. The workflow is the apex of the foreign-key
/// graph — nothing references it — so there are no foreign-key columns here. Its two many-to-many
/// relationships live entirely in the junction-table configurations, and declaring them here would
/// generate the navigation properties this model deliberately does without.
/// </summary>
internal sealed class WorkflowEntityConfiguration : IEntityTypeConfiguration<WorkflowEntity>
{
    public void Configure(EntityTypeBuilder<WorkflowEntity> entity)
    {
        // A generous upper bound for any cron shape. It is both a defensive limit at the
        // persistence layer and documentation that this is not an unbounded text column.
        entity.Property(e => e.CronExpression)
            .HasMaxLength(120);
    }
}
