using Microsoft.Extensions.DependencyInjection;

namespace BaseApi.Service.Features.Molecule;

internal static class MoleculeServiceCollectionExtensions
{
    /// <summary>The entity molecule's reads. IWorkflowGraphLoader comes from AddOrchestrationFeature.</summary>
    public static IServiceCollection AddMoleculeFeature(this IServiceCollection services)
    {
        services.AddScoped<ContextModelRelationsSource>();
        services.AddScoped<IModelRelationsSource>(sp => sp.GetRequiredService<ContextModelRelationsSource>());
        services.AddScoped<IModelRelationsReader>(sp => sp.GetRequiredService<ContextModelRelationsSource>());
        services.AddScoped<IMoleculeReader, MoleculeReader>();
        return services;
    }
}
