using BaseConsole.Core.Configuration;
using BaseConsole.Core.Startup;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

namespace BaseConsole.Core.DependencyInjection;

/// <summary>
/// The startup preflight: an operator-facing log of whether this process's own RabbitMQ and Redis
/// connections actually work, printed once at the top of every start. See
/// <see cref="Startup.StartupPreflightService"/> for the logging contract itself.
/// <para>
/// <b>Call this immediately after <c>AddBaseConsoleMessaging</c> / <c>AddBaseConsoleRedis</c> /
/// <c>AddBaseConsoleHealth</c>,</b> and before any other hosted service — both hosts do. Registering a
/// <see cref="Microsoft.Extensions.Hosting.BackgroundService"/> ahead of the loops that actually
/// recover from an outage is what makes this component's output lead the console, which is the whole
/// point of it.
/// </para>
/// </summary>
public static class ConsolePreflightServiceCollectionExtensions
{
    public static IServiceCollection AddBaseConsolePreflight(
        this IServiceCollection services, IConfiguration cfg)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(cfg);

        // Read and redact eagerly, at wiring time: the raw connection string exists only in this local
        // variable and is discarded the moment Redact returns. Nothing downstream of this line — not
        // the hosted service, not any field on it — ever holds the password.
        var redisEndpoint = RedisEndpointRedactor.Redact(cfg.RequireConnectionString("Redis"));

        services.TryAddSingleton(TimeProvider.System);
        services.TryAddSingleton<IRabbitMqConnectivityCheck, RabbitMqConnectivityCheck>();

        services.AddHostedService(sp => new StartupPreflightService(
            sp.GetRequiredService<IRabbitMqConnectivityCheck>(),
            sp.GetRequiredService<IOptions<RabbitMqOptions>>(),
            sp.GetRequiredService<IConnectionMultiplexer>(),
            redisEndpoint,
            sp.GetRequiredService<TimeProvider>(),
            sp.GetRequiredService<ILogger<StartupPreflightService>>()));

        return services;
    }
}
