using BaseConsole.Core.Configuration;
using BaseConsole.Core.Gating;
using BaseConsole.Core.Health;
using BaseConsole.Core.Loop;
using BaseConsole.Core.Messaging;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

namespace BaseConsole.Core.DependencyInjection;

/// <summary>
/// The console-side Redis client: one <see cref="IConnectionMultiplexer"/> for the process.
/// <para>
/// <b>A soft dependency, deliberately.</b> There is no startup probe and no readiness gate here. This
/// registration parses the connection string at wiring time and forces
/// <see cref="ConfigurationOptions.AbortOnConnectFail"/> to <c>false</c> on it — see
/// <see cref="ConsoleRedisConnectionOptions"/> — so the multiplexer materialises even against a dead
/// Redis and individual operations fail at their call sites instead. That is what lets a worker boot,
/// serve <c>/health/live</c>, and report the store as degraded rather than crash-loop on a dependency
/// that may be seconds from returning. The flag is enforced in code rather than left to the connection
/// string: three separate deployment files would otherwise each have to remember it independently, and
/// a fourth deployment, or one careless edit to any of them, would silently reintroduce the crash-loop.
/// </para>
/// <para>
/// <b>An operator's explicit <c>abortConnect=true</c> is silently overridden.</b> This is deliberate,
/// not an oversight: the console stack's gate-and-probe design (<c>L2Gate</c>, <c>L2GateProbe</c>,
/// <c>StartupPreflightService</c>) assumes the multiplexer always exists and may simply be
/// disconnected, and a hard failure inside this DI factory would kill the host during
/// <c>Host.StartAsync</c>'s hosted-service enumeration before any of those diagnostics — including the
/// one built specifically to announce that Redis is unreachable — ever ran. Silently ignoring an
/// operator's setting without documenting it would be worse than the original bug, so this paragraph is
/// that documentation.
/// </para>
/// <para>
/// <b>The connection is eager and synchronous, not lazy.</b> <see cref="ConnectionMultiplexer.Connect"/>
/// runs at resolution time on the resolving thread and blocks on the network round-trip — it does not
/// defer to first use. Even with <c>AbortOnConnectFail = false</c>, <c>Connect</c> still blocks for up
/// to <c>ConnectTimeout</c> (the manifests set 5000ms) before returning against a dead Redis, so startup
/// is delayed by roughly that much; that delay is the accepted cost of resolving the multiplexer
/// eagerly instead of deferring the connection to a background task a DI factory cannot await.
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

        // Read and parse eagerly so a missing or malformed connection string fails at wiring time
        // with an actionable message, rather than on whichever operation happens to resolve the
        // multiplexer first.
        var connectionString = cfg.RequireConnectionString("Redis");
        var options = ConsoleRedisConnectionOptions.ParseForcingNonAborting(connectionString);

        services.TryAddSingleton<IConnectionMultiplexer>(
            _ => ConnectionMultiplexer.Connect(options));

        return services;
    }

    /// <summary>Heartbeat key for the gate probe's loop. One holder per loop, never shared.</summary>
    public const string GateLoop = "l2-gate";

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

        // One liveness check over that same keyed holder, because a heartbeat nobody reads proves
        // nothing. If the probe loop stops iterating the gate never reopens, the consumer stays paused
        // forever, the work queue fills — and without this every probe stays green while it happens.
        // Nothing inside the process can restart a loop that is gone, so `live` (an external restart)
        // is the only repair available. The window is Interval x StaleFactor, which is also the only
        // reader L2GateOptions.StaleFactor has.
        services.AddHealthChecks()
            .Add(new HealthCheckRegistration(
                GateLoop,
                sp =>
                {
                    var options = sp.GetRequiredService<IOptions<L2GateOptions>>().Value;
                    return new LoopLivenessHealthCheck(
                        sp.GetRequiredKeyedService<ILoopHeartbeat>(GateLoop),
                        options.Interval * options.StaleFactor,
                        GateLoop,
                        sp.GetRequiredService<TimeProvider>());
                },
                HealthStatus.Unhealthy,
                ["live"]));

        services.TryAddSingleton<IConsumerAdmission, AlwaysOpenAdmission>();
        services.TryAddSingleton<GatedQueueConsumer>();
        services.AddHostedService(sp => sp.GetRequiredService<GatedQueueConsumer>());

        return services;
    }

    /// <summary>
    /// Registers an ADDITIONAL gated consumer on <paramref name="queue"/>, sharing the gate, probe and
    /// admission latch that <see cref="AddBaseConsoleGating"/> already registered. Call that first.
    /// <para>
    /// <b>Sharing the gate is the point.</b> One projection-store outage should pause every queue this
    /// process reads, not each one separately on its own first failure — and one probe loop, with one
    /// liveness check over it, is what makes "the store is reachable" a single answer rather than one
    /// per consumer that can disagree.
    /// </para>
    /// <para>
    /// <b>Options are constructed here rather than resolved.</b> <see cref="GatedConsumerOptions"/> is
    /// a single configured instance naming one queue, so a second consumer cannot read it and mean
    /// something different; each extra consumer is handed its own.
    /// </para>
    /// <para>
    /// <b>A plain <c>AddSingleton&lt;IHostedService&gt;</c>, NOT <c>AddHostedService</c>, and that is
    /// load-bearing.</b> <c>AddHostedService</c> registers through <c>TryAddEnumerable</c>, which
    /// de-duplicates on implementation type — so a second call naming the same <c>GatedQueueConsumer</c>
    /// type is silently dropped and the second queue is never consumed, with nothing anywhere to say
    /// so. The plain overload stacks.
    /// </para>
    /// </summary>
    public static IServiceCollection AddGatedQueue(this IServiceCollection services, string queue)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentException.ThrowIfNullOrWhiteSpace(queue);

        services.AddSingleton<IHostedService>(sp => new GatedQueueConsumer(
            sp.GetRequiredService<RabbitMqConnection>(),
            sp.GetRequiredService<L2Gate>(),
            sp.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new GatedConsumerOptions { Queue = queue }),
            sp.GetRequiredService<IConsumerAdmission>(),
            sp.GetRequiredService<ILogger<GatedQueueConsumer>>()));

        return services;
    }
}
