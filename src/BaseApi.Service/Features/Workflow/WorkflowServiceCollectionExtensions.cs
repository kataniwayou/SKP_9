using BaseApi.Core.Persistence;
using BaseApi.Core.Services;
using BaseApi.Service.Features.Workflow.Design;
using BaseApi.Service.Features.Workflow.Graph;
using Microsoft.Extensions.DependencyInjection;

namespace BaseApi.Service.Features.Workflow;

/// <summary>
/// Per-entity registration for the Workflow feature, composed together with the other feature
/// extensions by <c>AddAppFeatures</c>.
/// <para>
/// The abstract <see cref="BaseService{TEntity,TCreate,TUpdate,TRead}"/> alias is load-bearing: the
/// controller injects the abstract type, so without the alias the container cannot resolve it.
/// </para>
/// </summary>
internal static class WorkflowServiceCollectionExtensions
{
    public static IServiceCollection AddWorkflowFeature(this IServiceCollection services)
    {
        services.AddScoped<WorkflowService>();
        services.AddScoped<BaseService<WorkflowEntity, WorkflowCreateDto, WorkflowUpdateDto, WorkflowReadDto>>(
            sp => sp.GetRequiredService<WorkflowService>());

        // The SKP Studio graph endpoints. IWorkflowGraphLoader comes from AddOrchestrationFeature.
        services.AddScoped<IWorkflowGraphReader, WorkflowGraphReader>();
        services.AddScoped<GraphAssignmentResolver>();
        services.AddScoped<GraphSchemaEditor>();
        services.AddScoped<IWorkflowGraphSaver, WorkflowGraphSaver>();

        // Plan 8: the design save (store, then the stages in one transaction).
        services.AddScoped<IDesignStore, RelationalDesignStore>();
        services.AddScoped<IDesignTransactions, RelationalDesignTransactions>();
        services.AddScoped<IWorkflowDesignSyncer>(sp => new WorkflowDesignSyncer(
            sp.GetRequiredService<BaseDbContext>(), sp.GetRequiredService<IDesignStore>(),
            sp.GetRequiredService<IDesignTransactions>(), DesignStages.Ordered(sp)));

        // Runs via AddAppFeatures, so it lands after the core handlers and before the catch-all.
        services.AddExceptionHandler<GraphConflictExceptionHandler>();
        return services;
    }
}
