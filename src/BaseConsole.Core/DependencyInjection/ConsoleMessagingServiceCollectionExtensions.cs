using BaseConsole.Core.Configuration;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace BaseConsole.Core.DependencyInjection;

/// <summary>
/// The console-side broker client: one connection shared by the sender and every consumer, plus a
/// second one used only by the queue-stats probes. Mirrors the API-side registration — the settings
/// are read eagerly so a missing host or credential fails at wiring time with an actionable message
/// rather than on the first send.
/// <para>
/// <b>Two connections rather than one, and the second is not a scaling measure.</b> Consumer dispatch
/// is pinned to one thread per connection, so a probe opening and closing channels on the consumer
/// connection delays deliveries on it. <see cref="RabbitMqConnection"/> carries the measurement.
/// </para>
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
        //
        // Constructed by an explicit factory rather than by the container's constructor selection,
        // so the client name is passed here rather than defaulted. Both connections are the same
        // type and differ only by that name and by who holds them.
        services.TryAddSingleton(sp => new RabbitMqConnection(
            sp.GetRequiredService<IOptions<RabbitMqOptions>>(),
            sp.GetServices<IRabbitMqTopology>(),
            sp.GetRequiredService<ILogger<RabbitMqConnection>>(),
            RabbitMqConnection.PrimaryName));

        // The probe-only connection. Registered here rather than at each probe's own registration
        // so a host cannot end up with probes sharing the consumer connection by forgetting a line
        // -- the separation is the point, and it is worth nothing if it is opt-in per call site.
        // See RabbitMqConnection's remarks for the measurement behind it.
        services.TryAddKeyedSingleton(RabbitMqConnection.ProbeKey, (sp, _) => new RabbitMqConnection(
            sp.GetRequiredService<IOptions<RabbitMqOptions>>(),
            sp.GetServices<IRabbitMqTopology>(),
            sp.GetRequiredService<ILogger<RabbitMqConnection>>(),
            RabbitMqConnection.ProbeName));
        services.TryAddSingleton<IQueueSender, QueueSender>();
        services.TryAddSingleton<IQueueFanoutPublisher, QueueFanoutPublisher>();

        return services;
    }
}
