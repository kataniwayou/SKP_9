using BaseApi.Core.Configuration;
using BaseApi.Core.Gating;
using BaseApi.Core.Messaging;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace BaseApi.Core.DependencyInjection;

/// <summary>
/// Broker wiring: the shared connection, the send primitive, and the gate machinery that decides when
/// a consumer of the projection store is allowed to run.
///
/// <para>
/// <b>The send half and the consume half are registered separately and on purpose.</b> A service may
/// need to send control messages without hosting a consumer for them, and every service that gates a
/// consumer needs the gate and its probe whether or not it also sends. Folding them together would
/// force a sender to host a probe loop it has no use for — and that loop reports on liveness, so an
/// unused one is not inert.
/// </para>
///
/// <para>
/// <b>Nothing here names a concrete message, handler or queue.</b> Queues are declared by
/// <see cref="IRabbitMqTopology"/> units and handlers by <see cref="IQueueMessageHandler"/>
/// registrations, both supplied by the service that owns them. This assembly stays a transport, and
/// the dependency firewall holds.
/// </para>
/// </summary>
public static class MessagingServiceCollectionExtensions
{
    /// <summary>
    /// Registers the broker connection and the send primitive. Credentials come from configuration
    /// through the fail-fast helper, so a missing key is reported by name and never by value.
    /// </summary>
    public static IServiceCollection AddBaseApiMessaging(
        this IServiceCollection services, IConfiguration cfg)
    {
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

        // One connection for the sender and every consumer, and a SECOND one used only by the
        // queue-stats probes. Registering the concrete type rather than an interface is deliberate:
        // it owns lifetime and topology, and there is no second implementation to swap in.
        //
        // Constructed by explicit factories rather than by the container's constructor selection,
        // so each is given its client name here. See RabbitMqConnection's remarks for why the
        // probes are kept off the connection that carries consumer dispatch.
        services.TryAddSingleton(sp => new RabbitMqConnection(
            sp.GetRequiredService<IOptions<RabbitMqOptions>>(),
            sp.GetServices<IRabbitMqTopology>(),
            sp.GetRequiredService<ILogger<RabbitMqConnection>>(),
            RabbitMqConnection.PrimaryName));

        services.TryAddKeyedSingleton(RabbitMqConnection.ProbeKey, (sp, _) => new RabbitMqConnection(
            sp.GetRequiredService<IOptions<RabbitMqOptions>>(),
            sp.GetServices<IRabbitMqTopology>(),
            sp.GetRequiredService<ILogger<RabbitMqConnection>>(),
            RabbitMqConnection.ProbeName));
        services.TryAddSingleton<IQueueSender, QueueSender>();
        services.TryAddSingleton<IQueueFanoutPublisher, QueueFanoutPublisher>();

        return services;
    }

    /// <summary>
    /// Registers the gate, the probe loop that drives it, and the heartbeat the liveness check reads.
    /// <para>
    /// The probe is a hosted service and the gate is a singleton: the gate must outlive any single
    /// consumer, because its whole purpose is to be the one place several consumers agree about.
    /// </para>
    /// </summary>
    /// <summary>
    /// The <c>loop</c> label this host's gate probe reports under. The literal matches
    /// <c>ConsoleRedisServiceCollectionExtensions.GateLoop</c> deliberately: all three services run
    /// the same probe against the same store, so one value lets a single panel compare them. The
    /// two libraries do not reference each other, which is why it is written twice.
    /// </summary>
    public const string GateLoop = "l2-gate";

    public static IServiceCollection AddBaseApiL2Gate(
        this IServiceCollection services, IConfiguration cfg)
    {
        services.Configure<L2GateOptions>(cfg.GetSection("L2Gate"));

        services.TryAddSingleton<L2Gate>();
        // Wrapped, so the gate probe loop reports pipeline.loop.iterations as well as
        // stamping the holder the readiness check reads. The loop key matches the console
        // hosts' gate loop, so one panel compares all three services.
        services.TryAddSingleton<TimeProvider>(TimeProvider.System);
        services.TryAddSingleton<ILoopHeartbeat>(sp => new CountingLoopHeartbeat(
            new LoopHeartbeat(
                sp.GetRequiredService<TimeProvider>(),
                sp.GetRequiredService<ILogger<LoopHeartbeat>>()),
            GateLoop));
        services.AddHostedService<L2GateProbe>();

        // Hosted purely so the container constructs it: it owns the gauge registration, and a
        // singleton nothing resolves is an instrument that never publishes, silently.
        services.AddHostedService<L2GateMetrics>();

        return services;
    }

    /// <summary>
    /// Hosts a consumer for <paramref name="queue"/> that runs only while the gate is open.
    /// <para>
    /// The queue must be declared by a registered <see cref="IRabbitMqTopology"/>; this method binds a
    /// consumer to it and does not create it. Declaration belongs with the connection so that a queue
    /// exists even while its consumer is paused — otherwise a send during a startup outage would
    /// address a queue that does not exist yet.
    /// </para>
    /// </summary>
    public static IServiceCollection AddBaseApiGatedConsumer(
        this IServiceCollection services, string queue)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(queue);

        services.Configure<GatedConsumerOptions>(o => o.Queue = queue);
        services.AddSingleton<GatedQueueConsumer>();
        services.AddHostedService(sp => sp.GetRequiredService<GatedQueueConsumer>());

        return services;
    }
}
