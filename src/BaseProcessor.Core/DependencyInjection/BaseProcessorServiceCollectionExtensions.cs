using BaseConsole.Core.Health;
using BaseConsole.Core.Loop;
using BaseConsole.Core.Messaging;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Health;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Liveness;
using BaseProcessor.Core.Startup;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;

namespace BaseProcessor.Core.DependencyInjection;

/// <summary>
/// Wires the processor host: the identity holder, the two startup loops' collaborators, the liveness
/// loop, and the health checks that report on them.
/// <para>
/// <b>Prerequisites the caller registers.</b> This does not wire the broker or Redis:
/// <see cref="Messaging.Transport.IQueueSender"/>, <c>RabbitMqConnection</c> and
/// <c>IConnectionMultiplexer</c> belong to the console tier, which owns transport and observability
/// for every worker. Registering them here would invert that and drag a processor-shaped opinion into
/// the shared layer.
/// </para>
/// </summary>
public static class BaseProcessorServiceCollectionExtensions
{
    /// <summary>Heartbeat keys. One holder per loop — see <see cref="ILoopHeartbeat"/>.</summary>
    public const string StartupLoop  = "processor-startup";
    public const string LivenessLoop = "processor-liveness";

    /// <summary>
    /// Multiples of a loop's own cadence before a missing beat reads as dead. Three leaves room for
    /// one slow iteration without reporting a healthy loop as gone.
    /// </summary>
    private const int StaleFactor = 3;

    public static IServiceCollection AddBaseProcessor(
        this IServiceCollection services, IConfiguration cfg)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(cfg);

        services.Configure<ProcessorLivenessOptions>(cfg.GetSection("Processor"));

        services.TryAddSingleton(TimeProvider.System);
        services.TryAddSingleton<IProcessorContext, ProcessorContext>();
        services.TryAddSingleton<ISourceHashProvider, AssemblyMetadataSourceHashProvider>();
        services.TryAddSingleton<IStartupGate, StartupGate>();

        // Resolved once and shared, so the liveness key, the reply queue and the telemetry's
        // service.instance.id all name this replica identically. TryAdd, so a host that pins a
        // deterministic id — a test, say — wins.
        services.TryAddSingleton(InstanceId.Resolve());
        services.TryAddSingleton<ProcessorLivenessWriter>();

        // One slot shared by both startup loops: they never ask concurrently, and each drains it
        // before its own ask, so a leftover reply can never be mistaken for an answer.
        services.TryAddSingleton<ReplySlot<object>>();

        // The reply consumer and the endpoint seam are one object — the queue whose name is handed
        // out as ReplyTo has to be the queue that is actually being consumed.
        services.TryAddSingleton<ReplyQueueConsumer>();
        services.TryAddSingleton<IReplyEndpoint>(sp => sp.GetRequiredService<ReplyQueueConsumer>());

        // A holder per loop. Sharing one would let either loop's beat mask the other's death, which
        // is worse than not watching at all — it looks like coverage.
        services.AddKeyedSingleton<ILoopHeartbeat>(
            StartupLoop, (sp, _) => new LoopHeartbeat(sp.GetRequiredService<TimeProvider>()));
        services.AddKeyedSingleton<ILoopHeartbeat>(
            LivenessLoop, (sp, _) => new LoopHeartbeat(sp.GetRequiredService<TimeProvider>()));

        services.AddHostedService(sp => ActivatorUtilities.CreateInstance<ProcessorStartupOrchestrator>(
            sp, sp.GetRequiredKeyedService<ILoopHeartbeat>(StartupLoop)));
        services.AddHostedService(sp => ActivatorUtilities.CreateInstance<ProcessorLivenessHeartbeat>(
            sp, sp.GetRequiredKeyedService<ILoopHeartbeat>(LivenessLoop)));

        AddProcessorHealthChecks(services);

        return services;
    }

    /// <summary>
    /// One liveness check per loop, each with its own window and name, so a failure says which loop
    /// died. The two windows are derived from different numbers on purpose: the liveness loop runs on
    /// a fixed cadence, while the startup loops back off to a cap and would be reported dead at that
    /// cap under the shorter window.
    /// </summary>
    private static void AddProcessorHealthChecks(IServiceCollection services)
    {
        services.AddHealthChecks()
            .Add(new HealthCheckRegistration(
                "processor-startup-loop",
                sp => new LoopLivenessHealthCheck(
                    sp.GetRequiredKeyedService<ILoopHeartbeat>(StartupLoop),
                    TimeSpan.FromSeconds(
                        sp.GetRequiredService<IOptions<ProcessorLivenessOptions>>().Value.BackoffCapSeconds
                        * StaleFactor),
                    "startup",
                    sp.GetRequiredService<TimeProvider>()),
                HealthStatus.Unhealthy,
                ["live"]))
            .Add(new HealthCheckRegistration(
                "processor-liveness-loop",
                sp => new LoopLivenessHealthCheck(
                    sp.GetRequiredKeyedService<ILoopHeartbeat>(LivenessLoop),
                    TimeSpan.FromSeconds(
                        sp.GetRequiredService<IOptions<ProcessorLivenessOptions>>().Value.IntervalSeconds
                        * StaleFactor),
                    "liveness",
                    sp.GetRequiredService<TimeProvider>()),
                HealthStatus.Unhealthy,
                ["live"]))
            .Add(new HealthCheckRegistration(
                "processor-identity-ready",
                sp => new ProcessorIdentityReadyHealthCheck(sp.GetRequiredService<IProcessorContext>()),
                HealthStatus.Unhealthy,
                ["ready"]));
    }
}
