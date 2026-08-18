using BaseApi.Core.Services;
using Microsoft.Extensions.DependencyInjection;

namespace BaseApi.Service.Features.Processor;

/// <summary>
/// Per-entity registration for the Processor feature, composed together with the other feature
/// extensions by <c>AddAppFeatures</c>.
/// <para>
/// The abstract <see cref="BaseService{TEntity,TCreate,TUpdate,TRead}"/> alias is load-bearing: the
/// controller injects the abstract type, so without the alias the container cannot resolve it.
/// </para>
/// </summary>
internal static class ProcessorServiceCollectionExtensions
{
    public static IServiceCollection AddProcessorFeature(this IServiceCollection services)
    {
        services.AddScoped<ProcessorService>();
        services.AddScoped<BaseService<ProcessorEntity, ProcessorCreateDto, ProcessorUpdateDto, ProcessorReadDto>>(
            sp => sp.GetRequiredService<ProcessorService>());
        return services;
    }
}
