using BaseApi.Core.Services;
using Microsoft.Extensions.DependencyInjection;

namespace BaseApi.Service.Features.Schema;

/// <summary>
/// Per-entity registration for the Schema feature, composed together with the other feature
/// extensions by <c>AddAppFeatures</c>.
/// <para>
/// The abstract <see cref="BaseService{TEntity,TCreate,TUpdate,TRead}"/> alias is load-bearing: the
/// controller injects the abstract type, so without the alias the container cannot resolve it.
/// </para>
/// </summary>
internal static class SchemaServiceCollectionExtensions
{
    public static IServiceCollection AddSchemaFeature(this IServiceCollection services)
    {
        services.AddScoped<SchemaService>();
        services.AddScoped<BaseService<SchemaEntity, SchemaCreateDto, SchemaUpdateDto, SchemaReadDto>>(
            sp => sp.GetRequiredService<SchemaService>());

        // Registered here, which runs via AddAppFeatures, so it lands after the core handlers and
        // before the last-registered catch-all — walk order is registration order. Claims the
        // frozen-definition exception and emits a 409.
        services.AddExceptionHandler<SchemaDefinitionFrozenExceptionHandler>();
        return services;
    }
}
