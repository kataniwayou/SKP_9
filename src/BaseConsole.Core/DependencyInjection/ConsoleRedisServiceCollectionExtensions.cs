using BaseConsole.Core.Configuration;
using BaseConsole.Core.Gating;
using BaseConsole.Core.Loop;
using BaseConsole.Core.Messaging;
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

    /// <summary>
    /// Registers the projection-store gate, its probe, and one gated consumer bound to
    /// <paramref name="queue"/>.
    /// <para>
    /// The queue must already be declared by an <see cref="Messaging.Transport.IRabbitMqTopology"/>
    /// unit. The consumer deliberately does not declare it: a paused consumer declares nothing, and a
    /// send arriving in that window would address a queue that does not exist — which the broker
    /// discards while still confirming, so the sender is told the message was accepted.
    /// </para>
    /// </summary>
    /// <summary>Heartbeat key for the gate probe's loop. One holder per loop, never shared.</summary>
    public const string GateLoop = "l2-gate";

    public static IServiceCollection AddBaseConsoleGating(
        this IServiceCollection services, IConfiguration cfg, string queue)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(cfg);
        ArgumentException.ThrowIfNullOrWhiteSpace(queue);

        services.Configure<L2GateOptions>(cfg.GetSection("L2Gate"));
        services.Configure<GatedConsumerOptions>(o => o.Queue = queue);

        services.TryAddSingleton(TimeProvider.System);
        services.TryAddSingleton<L2Gate>();

        // The probe takes an ILoopHeartbeat, and on the console side every heartbeat is registered
        // KEYED — one holder per loop, because a holder shared between two loops lets the faster
        // loop's beat refresh the stamp for both and a dead loop stays invisible. There is no unkeyed
        // registration anywhere in this stack, so a plain AddHostedService<L2GateProbe>() would build
        // a service graph that fails to resolve at startup.
        services.AddKeyedSingleton<ILoopHeartbeat>(
            GateLoop, (sp, _) => new LoopHeartbeat(sp.GetRequiredService<TimeProvider>()));
        services.AddHostedService(sp => ActivatorUtilities.CreateInstance<L2GateProbe>(
            sp, sp.GetRequiredKeyedService<ILoopHeartbeat>(GateLoop)));

        services.TryAddSingleton<GatedQueueConsumer>();
        services.AddHostedService(sp => sp.GetRequiredService<GatedQueueConsumer>());

        return services;
    }
}
