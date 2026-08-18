using BaseApi.Core.Configuration;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using StackExchange.Redis;

namespace BaseApi.Core.DependencyInjection;

/// <summary>
/// Redis client wiring: a singleton <see cref="IConnectionMultiplexer"/> plus the
/// <see cref="RedisProjectionOptions"/> binding.
///
/// <para>
/// <see cref="IDatabase"/> is deliberately not registered. Consumers call
/// <c>multiplexer.GetDatabase()</c> per operation, which is the canonical pattern — the returned
/// object is a lightweight pass-through that does not need storing.
/// </para>
///
/// <para>
/// The synchronous <c>Connect</c> call is safe inside the singleton factory because the connection
/// string carries <c>abortConnect=false</c>, so boot never crashes on a dead Redis. The multiplexer
/// materializes even when Redis is unreachable, and operations then throw at their own call sites.
/// Connection happens lazily on first resolution; there is no pre-warm hosted service.
/// </para>
///
/// <para>
/// Singleton lifetime is the maintainer-recommended pattern: the multiplexer is thread-safe and
/// designed for long-lived reuse, and constructing one per request defeats the multiplexing model
/// and causes a connection storm.
/// </para>
///
/// <para>
/// This extension does not probe Redis at startup and does not register a health check. Redis is a
/// required, latched readiness dependency, but that check is registered in
/// <c>HealthServiceCollectionExtensions</c>.
/// </para>
/// </summary>
internal static class RedisServiceCollectionExtensions
{
    internal static IServiceCollection AddBaseApiRedis(
        this IServiceCollection services, IConfiguration cfg)
    {
        // Fail fast on a missing connection string, mirroring the persistence and health wiring.
        var connStr = cfg.RequireConnectionString("Redis");

        services.AddSingleton<IConnectionMultiplexer>(_ =>
            ConnectionMultiplexer.Connect(connStr));

        services.Configure<RedisProjectionOptions>(cfg.GetSection("Redis"));

        return services;
    }
}
