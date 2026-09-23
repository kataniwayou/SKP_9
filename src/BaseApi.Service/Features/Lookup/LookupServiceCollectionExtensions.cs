using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace BaseApi.Service.Features.Lookup;

/// <summary>
/// Registration for the lookup-table feature.
/// <para>
/// <b>The publisher is a singleton</b>, because the two things that keep it cheap — the staleness
/// floor and the last-published hash — are state that must survive between requests. A scoped
/// publisher would rebuild and republish on every dashboard render.
/// </para>
/// <para>
/// <b>Nothing here fails fast on missing configuration</b>, unlike the Postgres and broker
/// registrations. An absent <c>Kibana:BaseUrl</c> means the feature is off, which is the correct
/// behaviour for an environment with no Kibana — including the test host.
/// </para>
/// </summary>
internal static class LookupServiceCollectionExtensions
{
    public static IServiceCollection AddLookupFeature(this IServiceCollection services, IConfiguration cfg)
    {
        services.Configure<KibanaLookupOptions>(cfg.GetSection(KibanaLookupOptions.SectionName));
        services.AddHttpClient(nameof(KibanaLookupPublisher));
        services.AddSingleton<KibanaLookupPublisher>();
        return services;
    }
}
