using BaseConsole.Core.Configuration;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using StackExchange.Redis;

namespace BaseConsole.Core.DependencyInjection;

/// <summary>
/// The console-side Redis client: one <see cref="IConnectionMultiplexer"/> for the process.
/// <para>
/// <b>A soft dependency, deliberately.</b> There is no startup probe and no readiness gate here. The
/// connection string carries <c>abortConnect=false</c>, so the multiplexer materialises even against
/// a dead Redis and individual operations fail at their call sites instead — which is what lets a
/// worker boot, serve <c>/health/live</c>, and report the store as degraded rather than crash-loop on
/// a dependency that may be seconds from returning.
/// </para>
/// <para>
/// The connection opens lazily on first resolution: a DI factory cannot await, so connecting eagerly
/// would block a container-resolution thread on a network round-trip.
/// </para>
/// <para>
/// Unlike the API-side equivalent this binds no projection options type — that one is coupled to the
/// API's persistence concerns, and a worker taking it would invert the layering.
/// </para>
/// </summary>
public static class ConsoleRedisServiceCollectionExtensions
{
    public static IServiceCollection AddBaseConsoleRedis(
        this IServiceCollection services, IConfiguration cfg)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(cfg);

        // Read eagerly so a missing connection string fails at wiring time with an actionable
        // message, rather than on whichever operation happens to resolve the multiplexer first.
        var connectionString = cfg.RequireConnectionString("Redis");

        services.TryAddSingleton<IConnectionMultiplexer>(
            _ => ConnectionMultiplexer.Connect(connectionString));

        return services;
    }
}
