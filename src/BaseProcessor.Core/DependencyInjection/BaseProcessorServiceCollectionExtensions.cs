using BaseConsole.Core.DependencyInjection;
using BaseConsole.Core.Health;
using BaseConsole.Core.Loop;
using BaseConsole.Core.Messaging;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Health;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Liveness;
using BaseProcessor.Core.Messaging;
using BaseProcessor.Core.Observability;
using BaseProcessor.Core.Processing;
using BaseProcessor.Core.Startup;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace BaseProcessor.Core.DependencyInjection;

/// <summary>
/// Wires the processor host: the identity holder, the two startup loops' collaborators, the liveness
/// loop, and the health checks that report on them.
/// <para>
/// <b>It folds the console base in.</b> A concrete processor is a thin shell, so this one call brings
/// the broker, Redis and the health surface with it. That is not a layering violation — this assembly
/// already references the console library, and the prohibition runs the other way — while leaving the
/// four registrations to every processor author would make each of them a runtime failure waiting to
/// be forgotten.
/// </para>
/// <para>
/// <b>Observability stays the shell's own call.</b> It needs the host builder rather than the service
/// collection, and it needs the emitter <c>source</c>, which is the one thing only the concrete
/// console can answer.
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

    /// <summary>
    /// The two-stage boot's registration: the same graph, with <see cref="IProcessorContext"/> already
    /// carrying the identity Stage 1 resolved.
    /// <para>
    /// Seeding rather than resolving is what lets the OTel resource carry the identity at all. By the
    /// time this runs the answer is known, so the in-host retry that used to find it has nothing left
    /// to do — see <see cref="Startup.ProcessorStartupOrchestrator"/>, which now begins at Loop B.
    /// </para>
    /// </summary>
    public static IServiceCollection AddBaseProcessor(
        this IServiceCollection services, IConfiguration cfg, ProcessorIdentityFound identity)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(identity);

        // Registered before AddBaseProcessor's TryAddSingleton, so this pre-seeded instance wins.
        services.AddSingleton<IProcessorContext>(_ =>
        {
            var context = new ProcessorContext();
            context.SetIdentity(identity);
            return context;
        });

        services.AddBaseProcessor(cfg);

        // The only place the processor id is known before the container is built — everywhere else
        // it would have to be resolved from IProcessorContext, which is exactly the singleton this
        // topology and this queue name are handed to below instead.
        services.AddProcessorExecution(cfg, identity.Id);

        return services;
    }

    public static IServiceCollection AddBaseProcessor(
        this IServiceCollection services, IConfiguration cfg)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(cfg);

        // The console base: broker, Redis, startup latch and health probes.
        services.AddBaseConsoleMessaging(cfg);
        services.AddBaseConsoleRedis(cfg);
        services.AddBaseConsoleHealth(cfg);

        // The startup preflight: an operator-facing log of whether the connections just registered
        // above actually work. Registered ahead of every other hosted service below —
        // ProcessorStartupOrchestrator among them — so its output leads the console. It gates nothing
        // and recovers nothing; see ConsolePreflightServiceCollectionExtensions.
        services.AddBaseConsolePreflight(cfg);

        services.Configure<ProcessorLivenessOptions>(cfg.GetSection("Processor"));

        services.TryAddSingleton(TimeProvider.System);
        services.TryAddSingleton<IProcessorContext, ProcessorContext>();

        // Hosted purely so the container constructs it; see the type's own remarks.
        services.AddHostedService<ProcessorPipelineMetricsHost>();
        // No ISourceHashProvider here. The hash answers one question — "which row is mine" — and that
        // is settled before this container exists; Stage 1 registers its own inside the boot. A copy
        // here would resolve for nobody while reading like a live dependency.
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

    /// <summary>
    /// Registers the execution path: the queue topology, the two handlers, and the gated consumer
    /// that feeds them.
    /// <para>
    /// The consumer's prefetch stays at its default of one. That is structural, not a tuning knob —
    /// the per-dispatch state on the singleton processor is a plain field, and a second concurrent
    /// dispatch would overwrite it.
    /// </para>
    /// <para>
    /// The author registers their own <c>BaseProcessor</c> implementation; this method does not, so a
    /// host that forgets fails to resolve the handler at startup rather than consuming and failing
    /// every message.
    /// </para>
    /// </summary>
    public static IServiceCollection AddProcessorExecution(
        this IServiceCollection services, IConfiguration cfg, Guid processorId)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(cfg);

        services.AddSingleton<IRabbitMqTopology>(_ => new ProcessorTopology(processorId));

        services.AddScoped<IQueueMessageHandler, ProcessDispatchHandler>();
        services.AddScoped<IQueueMessageHandler, ProcessedDataHandler>();

        services.AddBaseConsoleGating(cfg, ProcessorQueues.Work(processorId));

        // How much work is waiting on this processor's queue, and whether the broker still has a
        // consumer on it.
        //
        // Registered here rather than in a host because every processor has exactly one work queue
        // and it is named from the id this method already takes. A host that forgot would be a
        // processor whose backlog nobody could see, and there would be nothing to notice.
        //
        // This is the queue where a backlog matters most: replicas share it, so it is the one place
        // where the pipeline's throughput ceiling shows up as a level rather than as a rate that
        // merely looks lower than usual.
        // Its own work queue, plus every queue this processor has SENT to -- step outcomes go to
        // orchestrator-result, which the orchestrator is otherwise the only process watching. That
        // asymmetry was measured: with the orchestrator scaled to zero the number of queues observed
        // anywhere fell from 7 to 1 and `Queues unconsumed` read a confident 0, unable to tell "none
        // unconsumed" from "six unobservable".
        services.AddHostedService(sp => new QueueDepthProbe(
            sp.GetRequiredService<RabbitMqConnection>(),
            () => [ProcessorQueues.Work(processorId), .. DispatchedQueues.Snapshot()],
            TimeSpan.FromSeconds(10),
            sp.GetRequiredService<ILogger<QueueDepthProbe>>(),
            DispatchedQueues.Note));

        return services;
    }
}
