using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Schema;
using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service;

/// <summary>
/// The application's context: five entity sets and three junction sets.
/// <para>
/// The ordering inside <c>OnModelCreating</c> is load-bearing — see the comment there.
/// </para>
/// </summary>
public sealed class AppDbContext : BaseDbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }

    public DbSet<SchemaEntity> Schemas => Set<SchemaEntity>();
    public DbSet<ProcessorEntity> Processors => Set<ProcessorEntity>();
    public DbSet<StepEntity> Steps => Set<StepEntity>();
    public DbSet<AssignmentEntity> Assignments => Set<AssignmentEntity>();
    public DbSet<WorkflowEntity> Workflows => Set<WorkflowEntity>();

    public DbSet<StepNextSteps> StepNextSteps => Set<StepNextSteps>();
    public DbSet<WorkflowEntrySteps> WorkflowEntrySteps => Set<WorkflowEntrySteps>();
    public DbSet<WorkflowAssignments> WorkflowAssignments => Set<WorkflowAssignments>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        // Order matters: apply the entity configurations first, so every entity is on the model,
        // then call the base last, so its xmin shadow-token loop sees all the configured entities
        // and stamps each one. Reversing these leaves the token off the generated schema.
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(AppDbContext).Assembly);
        base.OnModelCreating(modelBuilder);
    }
}
