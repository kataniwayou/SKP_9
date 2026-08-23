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
/// <b>The connection string is parsed at wiring time and <c>AbortOnConnectFail</c> is forced to
/// <c>false</c> on the resulting <see cref="ConfigurationOptions"/></b>, silently overriding an
/// operator's explicit <c>abortConnect=true</c> if present. See <see cref="ApiRedisConnectionOptions"/>
/// for why — that is the single place this is explained, rather than repeating it here. One consequence
/// worth stating here: parsing at wiring time also changes when a malformed connection string fails.
/// Previously it surfaced wherever the multiplexer was first resolved; now
/// <see cref="ConfigurationOptions.Parse(string)"/> throws at <c>AddBaseApiRedis</c> itself, during
/// service registration.
/// </para>
/// <para>
/// <b>The connect is eager and synchronous, not lazy.</b>
/// <see cref="ConnectionMultiplexer.Connect(ConfigurationOptions, System.IO.TextWriter)"/> runs at
/// resolution time on the resolving thread and blocks — up to <c>ConnectTimeout</c> against a dead
/// Redis — rather than deferring to first use. This matches how <c>ApiRedisReadyHealthCheck</c> already
/// documents the same call.
/// </para>
///
/// <para>
/// Singleton lifetime is the maintainer-recommended pattern: the multiplexer is thread-safe and
/// designed for long-lived reuse, and constructing one per request defeats the multiplexing model
/// and causes a connection storm.
/// </para>
///
/// <para>
/// This extension does not probe Redis at startup and does not register a health check.
/// <b>Redis is neither required nor latched for readiness</b> — it is registered in
/// <c>HealthServiceCollectionExtensions</c> capped at degraded and deliberately unlatched, because a
/// latch that never self-heals is incompatible with pausing consumption to ride out an outage. That
/// type's remarks carry the full reasoning; this note exists only so nobody reasons about readiness
/// from here and reaches the opposite conclusion.
/// </para>
/// </summary>
internal static class RedisServiceCollectionExtensions
{
    internal static IServiceCollection AddBaseApiRedis(
        this IServiceCollection services, IConfiguration cfg)
    {
        // Fail fast on a missing connection string, mirroring the persistence and health wiring.
        // Parsed eagerly too, so a malformed string also fails here rather than at whichever
        // operation happens to resolve the multiplexer first.
        var connStr = cfg.RequireConnectionString("Redis");
        var options = ApiRedisConnectionOptions.ParseForcingNonAborting(connStr);

        services.AddSingleton<IConnectionMultiplexer>(_ =>
            ConnectionMultiplexer.Connect(options));

        services.Configure<RedisProjectionOptions>(cfg.GetSection("Redis"));

        return services;
    }
}
