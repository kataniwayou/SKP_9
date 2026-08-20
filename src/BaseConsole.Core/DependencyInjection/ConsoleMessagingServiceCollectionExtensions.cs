using BaseConsole.Core.Configuration;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace BaseConsole.Core.DependencyInjection;

/// <summary>
/// The console-side broker client: one connection for the process, shared by the sender and every
/// consumer. Mirrors the API-side registration — the settings are read eagerly so a missing host or
/// credential fails at wiring time with an actionable message rather than on the first send.
/// </summary>
public static class ConsoleMessagingServiceCollectionExtensions
{
    public static IServiceCollection AddBaseConsoleMessaging(
        this IServiceCollection services, IConfiguration cfg)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(cfg);

        var host = cfg.Require("RabbitMq:Host");
        var user = cfg.Require("RabbitMq:Username");
        var pass = cfg.Require("RabbitMq:Password");

        services.Configure<RabbitMqOptions>(o =>
        {
            o.Host        = host;
            o.Username    = user;
            o.Password    = pass;
            o.Port        = cfg.GetValue<ushort?>("RabbitMq:Port") ?? 5672;
            o.VirtualHost = cfg["RabbitMq:VirtualHost"] ?? "/";
        });

        // The concrete type rather than an interface, deliberately: it owns lifetime and topology
        // declaration, and there is no second implementation to swap in.
        services.TryAddSingleton<RabbitMqConnection>();
        services.TryAddSingleton<IQueueSender, QueueSender>();
        services.TryAddSingleton<IQueueFanoutPublisher, QueueFanoutPublisher>();

        return services;
    }
}
