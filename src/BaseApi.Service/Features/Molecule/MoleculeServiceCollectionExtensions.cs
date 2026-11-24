using Microsoft.Extensions.DependencyInjection;

namespace BaseApi.Service.Features.Molecule;

internal static class MoleculeServiceCollectionExtensions
{
    /// <summary>The model change set: /model/validate's dry run and /model/apply.</summary>
    public static IServiceCollection AddMoleculeFeature(this IServiceCollection services)
    {
        services.AddScoped<IModelChangesValidator, ModelChangeRunner>();
        return services;
    }
}
