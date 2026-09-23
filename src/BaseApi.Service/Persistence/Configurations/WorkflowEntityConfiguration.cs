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

        // NO LENGTH BOUND, UNLIKE EVERY OTHER COLUMN HERE. A diagram is generated SVG whose size
        // tracks the workflow's shape - the two committed drawings are 5.6 KB and 15.8 KB - and any
        // cap would be a guess that eventually truncates a large graph into invalid XML. Postgres
        // stores this out of line via TOAST, so an unbounded text column costs nothing on the rows
        // that leave it null, which is every workflow until an operator publishes one.
        entity.Property(e => e.Diagram)
            .HasColumnType("text");
    }
}
