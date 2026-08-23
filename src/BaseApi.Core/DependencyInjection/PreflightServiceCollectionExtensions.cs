using BaseApi.Core.Configuration;
using BaseApi.Core.Startup;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

namespace BaseApi.Core.DependencyInjection;

/// <summary>
/// The startup preflight: an operator-facing log of whether this process's own RabbitMQ and Redis
/// connections actually work. See <see cref="ApiStartupPreflightService"/> for the logging contract.
/// <para>
/// <b>It is the first link in <c>AddBaseApi</c>'s chain, and that position is the point of it.</b>
/// Hosted services start in registration order, so registering ahead of
/// <c>StartupCompletionService</c> — which runs migrations and can sit on a dead Postgres for the
/// length of a connect timeout — is what puts the preflight's output at the top of
/// <c>kubectl logs</c> rather than behind it.
/// </para>
/// <para>
/// <b>It resolves <see cref="RabbitMqConnection"/>, which <c>AddBaseApiMessaging</c> registers on the
/// same collection.</b> Registration order does not matter for resolution, only that both calls
/// happen before the host is built — which is the only composition this API has. If the broker
/// wiring is ever made optional, this becomes a resolution failure at host start rather than a
/// silent skip, which is the honest failure: a preflight that quietly checked one dependency would
/// be trusted for two.
/// </para>
/// </summary>
internal static class PreflightServiceCollectionExtensions
{
    internal static IServiceCollection AddBaseApiPreflight(
        this IServiceCollection services, IConfiguration cfg)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(cfg);

        // Read and redact eagerly, at wiring time: the raw connection string exists only in this local
        // variable and is discarded the moment Redact returns. Nothing downstream of this line — not
        // the hosted service, not any field on it — ever holds the password.
        var redisEndpoint = ApiRedisEndpointRedactor.Redact(cfg.RequireConnectionString("Redis"));

        services.TryAddSingleton(TimeProvider.System);
        services.TryAddSingleton<IApiBrokerConnectivityCheck, ApiBrokerConnectivityCheck>();

        services.AddHostedService(sp => new ApiStartupPreflightService(
            sp.GetRequiredService<IApiBrokerConnectivityCheck>(),
            sp.GetRequiredService<IOptions<RabbitMqOptions>>(),
            sp.GetRequiredService<IConnectionMultiplexer>(),
            redisEndpoint,
            sp.GetRequiredService<TimeProvider>(),
            sp.GetRequiredService<ILogger<ApiStartupPreflightService>>()));

        return services;
    }
}
