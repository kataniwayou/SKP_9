using BaseApi.Core.Configuration;
using BaseApi.Core.Persistence;
using BaseApi.Core.Persistence.Interceptors;
using BaseApi.Core.Persistence.Repositories;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace BaseApi.Core.DependencyInjection;

/// <summary>
/// Persistence wiring: the context with Npgsql and snake_case naming, the audit interceptor, the
/// open-generic repository, and a <see cref="BaseDbContext"/> alias resolving to the concrete context.
/// </summary>
internal static class PersistenceServiceCollectionExtensions
{
    internal static IServiceCollection AddBaseApiPersistence<TDbContext>(
        this IServiceCollection services, IConfiguration cfg)
        where TDbContext : BaseDbContext
    {
        services.AddHttpContextAccessor();                                     // idempotent
        services.AddSingleton(TimeProvider.System);
        services.AddSingleton<AuditInterceptor>();

        services.AddDbContext<TDbContext>((sp, opts) =>
        {
            // Fail fast with a clear message rather than letting null reach UseNpgsql, which
            // throws something far less diagnosable.
            opts.UseNpgsql(cfg.RequireConnectionString("Postgres"))
                .UseSnakeCaseNamingConvention()
                .AddInterceptors(sp.GetRequiredService<AuditInterceptor>());
        });

        services.AddScoped(typeof(IRepository<>), typeof(Repository<>));
        // The BaseDbContext alias lets BaseService resolve the abstract type. Its lifetime must match
        // the concrete context's — both scoped — or the alias becomes a captive dependency.
        services.AddScoped<BaseDbContext>(sp => sp.GetRequiredService<TDbContext>());
        return services;
    }
}
