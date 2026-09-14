using BaseApi.Core.Services;
using Microsoft.Extensions.DependencyInjection;

namespace BaseApi.Service.Features.Cache;

internal static class CacheServiceCollectionExtensions
{
    public static IServiceCollection AddCacheFeature(this IServiceCollection services)
    {
        services.AddScoped<CacheService>();
        services.AddScoped<BaseService<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto>>(
            sp => sp.GetRequiredService<CacheService>());
        return services;
    }
}
