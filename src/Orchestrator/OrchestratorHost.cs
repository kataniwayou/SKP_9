using BaseConsole.Core.DependencyInjection;
using BaseConsole.Core.Health;
using BaseConsole.Core.Loop;
using BaseConsole.Core.Messaging;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Hosting;
using Orchestrator.Hydration;
using Orchestrator.Messaging;

namespace Orchestrator;

/// <summary>
/// The composition root, as methods rather than inline in <c>Program</c> so that the one thing worth
/// asserting about a shell — that its service graph actually resolves — can be asserted without
/// starting a process.
/// <para>
/// <b>No two-stage boot.</b> Unlike a processor, this replica's identity is not a database row to
/// discover — <see cref="InstanceId.Resolve"/> reads it straight from the StatefulSet ordinal, so
/// there is no window in which the host does not yet know who it is.
/// </para>
/// <para>
/// <b>Registrations run in a flat, ordered block rather than a fluent chain</b> so that a line can be
/// inserted ahead of <see cref="ConsoleRedisServiceCollectionExtensions.AddBaseConsoleGating"/> without
/// restructuring anything around it. <see cref="Hydration.HydrationAdmission"/> is why that matters and
/// is already there: gating resolves <see cref="IConsumerAdmission"/> with <c>TryAddSingleton</c>, so
/// the first registration wins and one made below that call would be discarded in silence. Anything
/// added later that gating also <c>TryAdd</c>s belongs above it too.
/// </para>
/// </summary>
public static class OrchestratorHost
{
    /// <summary>
    /// Heartbeat key for the hydration loop, and the name its liveness check is registered under. One
    /// holder per loop — see <see cref="ILoopHeartbeat"/> — because a holder shared between two loops
    /// lets the live one's beat cover for the dead one.
    /// </summary>
    public const string HydrationLoop = "orchestrator-hydration";

    /// <summary>
    /// The production entry point: builds the host, starts it, and returns it running.
    /// </summary>
    public static async Task<IHost> StartAsync(
        string[] args, CancellationToken ct, Action<IConfigurationBuilder>? configure = null)
    {
        var host = Create(args, configure);
        await host.StartAsync(ct).ConfigureAwait(false);
        return host;
    }

    /// <summary>
    /// Builds the host without starting it, so a test can assert the graph resolves without a broker
    /// or a Redis connection ever being opened — every registration below is lazy until resolved.
    /// </summary>
    public static IHost Create(string[] args, Action<IConfigurationBuilder>? configure = null)
    {
        var builder = Host.CreateApplicationBuilder(args);
        configure?.Invoke(builder.Configuration);

        // The same replica identity that names this process's fan-out queue, its dead queue, and the
        // service.instance.id resource attribute AddBaseConsoleObservability resolves independently.
        var instanceId = InstanceId.Resolve();
        builder.Services.AddSingleton(instanceId);

        builder.AddBaseConsoleObservability(builder.Configuration, source: "worker");

        // The broker and Redis clients, and the health surface every console carries regardless of
        // what it does. Redis is required here — not merely by convention — because
        // AddBaseConsoleGating's probe loop measures the projection store's reachability; without it
        // that loop would fail to resolve the moment it is started.
        builder.Services.AddBaseConsoleMessaging(builder.Configuration);
        builder.Services.AddBaseConsoleRedis(builder.Configuration);
        builder.Services.AddBaseConsoleHealth(builder.Configuration);

        builder.Services.AddSingleton<IRabbitMqTopology>(_ => new OrchestratorTopology(instanceId));

        // Loop 2 and its admission latch. The position of the next two lines is the point of them
        // being here at all: AddBaseConsoleGating below resolves IConsumerAdmission with
        // TryAddSingleton, so a registration made after it loses to AlwaysOpenAdmission without
        // failing and without logging, and the replica then consumes announcements before it has
        // mirrored L2. One instance under two registrations, not two instances: the loop has to open
        // the latch the consumer reads.
        builder.Services.AddSingleton<HydrationAdmission>();
        builder.Services.AddSingleton<IConsumerAdmission>(
            sp => sp.GetRequiredService<HydrationAdmission>());

        builder.Services.AddKeyedSingleton<ILoopHeartbeat>(
            HydrationLoop, (sp, _) => new LoopHeartbeat(sp.GetRequiredService<TimeProvider>()));

        // A heartbeat nobody reads proves nothing. The window is HydrationService's own backoff cap
        // times its stale factor, derived there so it cannot fall below the delay it has to cover.
        // Tagged `live` and nothing else: a hydration loop still retrying an unreachable L2 is this
        // design working, and only a loop that has stopped iterating is worth a restart.
        builder.Services.AddHealthChecks()
            .Add(new HealthCheckRegistration(
                HydrationLoop,
                sp => new LoopLivenessHealthCheck(
                    sp.GetRequiredKeyedService<ILoopHeartbeat>(HydrationLoop),
                    HydrationService.LivenessWindow,
                    "hydration",
                    sp.GetRequiredService<TimeProvider>()),
                HealthStatus.Unhealthy,
                ["live"]));

        builder.Services.AddHostedService(sp => ActivatorUtilities.CreateInstance<HydrationService>(
            sp, sp.GetRequiredKeyedService<ILoopHeartbeat>(HydrationLoop)));

        builder.Services.AddBaseConsoleGating(
            builder.Configuration, OrchestratorFanout.PerReplica(instanceId.Value));

        return builder.Build();
    }
}
