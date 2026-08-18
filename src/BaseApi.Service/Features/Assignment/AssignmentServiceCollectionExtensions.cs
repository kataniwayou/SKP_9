using BaseApi.Core.Services;
using Microsoft.Extensions.DependencyInjection;

namespace BaseApi.Service.Features.Assignment;

/// <summary>
/// Per-entity registration for the Assignment feature, composed together with the other feature
/// extensions by <c>AddAppFeatures</c>.
/// <para>
/// The abstract <see cref="BaseService{TEntity,TCreate,TUpdate,TRead}"/> alias is load-bearing: the
/// controller injects the abstract type, so without the alias the container cannot resolve it.
/// </para>
/// </summary>
internal static class AssignmentServiceCollectionExtensions
{
    public static IServiceCollection AddAssignmentFeature(this IServiceCollection services)
    {
        services.AddScoped<AssignmentService>();
        services.AddScoped<BaseService<AssignmentEntity, AssignmentCreateDto, AssignmentUpdateDto, AssignmentReadDto>>(
            sp => sp.GetRequiredService<AssignmentService>());
        return services;
    }
}
