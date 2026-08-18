using BaseApi.Core.Services;
using Microsoft.Extensions.DependencyInjection;

namespace BaseApi.Service.Features.Step;

/// <summary>
/// Per-entity registration for the Step feature, composed together with the other feature
/// extensions by <c>AddAppFeatures</c>.
/// <para>
/// The abstract <see cref="BaseService{TEntity,TCreate,TUpdate,TRead}"/> alias is load-bearing: the
/// controller injects the abstract type, so without the alias the container cannot resolve it.
/// </para>
/// </summary>
internal static class StepServiceCollectionExtensions
{
    public static IServiceCollection AddStepFeature(this IServiceCollection services)
    {
        services.AddScoped<StepService>();
        services.AddScoped<BaseService<StepEntity, StepCreateDto, StepUpdateDto, StepReadDto>>(
            sp => sp.GetRequiredService<StepService>());
        return services;
    }
}
