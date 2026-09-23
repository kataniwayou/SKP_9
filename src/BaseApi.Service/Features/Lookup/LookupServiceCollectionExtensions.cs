using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace BaseApi.Service.Features.Lookup;

/// <summary>
/// Registration for the entity id → name table.
/// <para>
/// <b>The publisher is a singleton and holds no state.</b> It is one because the HTTP client factory
/// and options are, not because anything is remembered between calls — every publish sends the whole
/// table for the workflow being started, so two concurrent starts cannot produce a partial result.
/// </para>
/// <para>
/// <b>An absent <c>Elasticsearch:BaseUrl</c> disables the feature.</b> Unlike Postgres and the broker
/// this is not fail-fast: the test host runs without a log store, and a service that refused to boot
/// without one would make every unrelated test need an Elasticsearch.
/// </para>
/// </summary>
internal static class LookupServiceCollectionExtensions
{
    public static IServiceCollection AddLookupFeature(this IServiceCollection services, IConfiguration cfg)
    {
        services.Configure<ElasticLookupOptions>(cfg.GetSection(ElasticLookupOptions.SectionName));
        services.AddHttpClient(nameof(ElasticLookupPublisher));
        services.AddSingleton<IEntityLookupPublisher, ElasticLookupPublisher>();
        services.AddHostedService<LookupProvisioningService>();
        return services;
    }
}
