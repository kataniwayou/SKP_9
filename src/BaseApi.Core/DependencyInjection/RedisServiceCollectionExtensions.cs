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
/// <c>false</c> on the resulting <see cref="ConfigurationOptions"/></b> — see
/// <see cref="ApiRedisConnectionOptions"/> for why this is enforced in code rather than left to
/// configuration. An operator's explicit <c>abortConnect=true</c> is silently overridden as a result:
/// this is deliberate, not an oversight. Redis is a required, latched readiness dependency here (see
/// below), and <c>ApiRedisReadyHealthCheck</c> is built on the assumption that the multiplexer always
/// materialises and may simply be disconnected — never that resolving it can throw. A throw inside this
/// DI factory would turn a not-ready condition into a dead or perpetually-throwing one instead, since
/// DI does not cache a failed singleton factory and re-invokes (and re-throws from) it on every
/// subsequent resolution.
/// </para>
/// <para>
/// <b>The connect is eager and synchronous, not lazy.</b>
/// <see cref="ConnectionMultiplexer.Connect(ConfigurationOptions, System.IO.TextWriter)"/> runs at
/// resolution time on the resolving thread and blocks on the network round-trip — it does not
/// defer to first use. Even with <c>AbortOnConnectFail = false</c>, it still blocks for up to
/// <c>ConnectTimeout</c> before returning against a dead Redis. There is no pre-warm hosted service in
/// this file, but note that other registrations in this assembly (<c>AddBaseApiL2Gate</c>'s
/// <c>L2GateProbe</c>, when wired) resolve <see cref="IConnectionMultiplexer"/> from a hosted service
/// constructor, which pulls this synchronous connect into host startup for services that register it.
/// </para>
/// <para>
/// <b>Parsing at wiring time changes when a malformed connection string fails.</b> Previously a
/// malformed string surfaced wherever the multiplexer was first resolved; now
/// <see cref="ConfigurationOptions.Parse(string)"/> throws at <c>AddBaseApiRedis</c> itself, i.e. during
/// service registration rather than at first use.
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
