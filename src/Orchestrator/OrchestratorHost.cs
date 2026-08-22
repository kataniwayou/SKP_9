using BaseConsole.Core.DependencyInjection;
using BaseConsole.Core.Health;
using BaseConsole.Core.Loop;
using BaseConsole.Core.Messaging;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Hosting;
using OpenTelemetry.Metrics;
using Orchestrator.Election;
using Orchestrator.Hydration;
using Orchestrator.L1;
using Orchestrator.Messaging;
using Orchestrator.Observability;
using Orchestrator.Scheduling;
using Quartz;

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
/// is already there: gating <c>TryAdd</c>s <c>AlwaysOpenAdmission</c> as the default
/// <see cref="IConsumerAdmission"/>, and registering above that call is what makes gating's <c>TryAdd</c>
/// a no-op, leaving exactly one descriptor. Below it there would be two — the plain <c>AddSingleton</c>
/// used here would still win, because a single-service resolution returns the last registration, but
/// the default would sit in the collection to be constructed by any enumeration, and the same line
/// written as a <c>TryAddSingleton</c> would lose to it outright and in silence. Anything added later
/// that gating also <c>TryAdd</c>s belongs above it for the same reason.
/// </para>
/// </summary>
public static class OrchestratorHost
{
    /// <summary>
    /// Heartbeat key for the hydration loop, and the name its liveness check is registered under. One
    /// holder per loop — see <see cref="ILoopHeartbeat"/> — because a holder shared between two loops
    /// lets the live one's beat cover for the dead one.
    /// <para>
    /// Points at <see cref="HydrationService.LoopName"/> rather than restating the literal — the loop
    /// names itself, and a composition root reading that name from the loop (not the other way round)
    /// is what keeps the two from drifting apart.
    /// </para>
    /// </summary>
    public const string HydrationLoop = HydrationService.LoopName;

    /// <summary>
    /// The name the readiness check over <see cref="Hydration.HydrationAdmission"/> is registered
    /// under. Distinct from <see cref="HydrationLoop"/> because the two answer different questions
    /// about the same loop — that one is whether it is still turning, this one whether it has
    /// finished — and a probe body naming both is how an operator tells those apart.
    /// </summary>
    public const string HydrationReady = "orchestrator-hydrated";

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

        // A second WithMetrics on the same OpenTelemetryBuilder adds to the provider the shared
        // call configured rather than replacing it. The role meter is added here rather than
        // inside AddBaseConsoleObservability so that method's contract stays role-agnostic.
        builder.Services.AddOpenTelemetry()
            .WithMetrics(m => m.AddMeter(OrchestratorPipelineMetrics.MeterName));

        // The broker and Redis clients, and the health surface every console carries regardless of
        // what it does. Redis is required here — not merely by convention — because
        // AddBaseConsoleGating's probe loop measures the projection store's reachability; without it
        // that loop would fail to resolve the moment it is started.
        builder.Services.AddBaseConsoleMessaging(builder.Configuration);
        builder.Services.AddBaseConsoleRedis(builder.Configuration);
        builder.Services.AddBaseConsoleHealth(builder.Configuration);

        // The startup preflight: an operator-facing log of whether the connections just registered
        // above actually work. Registered ahead of every other hosted service below — HydrationService
        // among them — so its output leads the console. It gates nothing and recovers nothing; see
        // ConsolePreflightServiceCollectionExtensions.
        builder.Services.AddBaseConsolePreflight(builder.Configuration);

        builder.Services.AddSingleton<IRabbitMqTopology>(_ => new OrchestratorTopology(instanceId));

        // Scheduling. Quartz's defaults are what this needs and all of it: the in-memory job store,
        // because every job here is re-derivable from L2 by the hydration pass that runs before this
        // replica consumes anything, so a job store that outlived the process would only be a second,
        // staler source of truth; and the Microsoft DI job factory, because the fire job is built from
        // this container once per fire. WaitForJobsToComplete lets a fire already dispatching finish
        // rather than being torn out mid-send when the pod is asked to stop.
        //
        // These two register an ISchedulerFactory and the hosted service that starts the scheduler,
        // and no IScheduler — deliberately, on Quartz's part: acquiring one is asynchronous and its
        // lifecycle belongs to that hosted service. WorkflowScheduler<TJob> takes the factory for
        // exactly that reason, so nothing here has to block a container-resolution thread to hand it
        // a scheduler.
        builder.Services.AddQuartz();
        builder.Services.AddQuartzHostedService(o => o.WaitForJobsToComplete = true);

        // Transient, and registered at all rather than left to the job factory's create-if-absent
        // fallback: an unregistered job type still resolves at fire time, but it does so outside
        // ValidateOnBuild's reach, so a fire-job dependency nobody registered would surface on the
        // first trigger, on a background thread, instead of when the host is built. Transient because
        // Quartz builds one instance per fire.
        builder.Services.AddTransient<WorkflowFireJob>();

        // The clock the scheduler does its cron arithmetic on. AddBaseConsoleGating below TryAdds the
        // same instance; this is deliberately the same TryAdd rather than a second, different
        // registration, so the scheduling block does not depend on a call thirty lines below it for
        // something as basic as its clock, and whichever call runs first gives the same answer.
        builder.Services.TryAddSingleton(TimeProvider.System);

        // The one place WorkflowScheduler<TJob>'s open job type is closed, and the registration that
        // makes the whole graph resolvable — WorkflowActivator, both apply handlers and the fire job
        // itself all reach IWorkflowScheduler. Closing it over anything but WorkflowFireJob would
        // leave every trigger armed and firing something that dispatches nothing: schedules intact,
        // workflows silently dead.
        builder.Services.AddSingleton<IWorkflowScheduler, WorkflowScheduler<WorkflowFireJob>>();

        // L1: the in-memory mirror of L2, and the single activation path that fills it. Registered
        // here rather than left for each caller to new one up, because both hydration (below) and the
        // apply handlers (below that) are constructor-injected consumers of the same three instances —
        // one store, one reader, one activator per replica, not one per caller.
        builder.Services.AddSingleton<WorkflowL1Store>();
        builder.Services.AddSingleton<L2WorkflowReader>();
        builder.Services.AddSingleton<WorkflowActivator>();

        // The leadership gate, and the election that writes it. The gate is registered
        // unconditionally because every fire on every replica reads it; the election is registered
        // only in-cluster, because it is the only thing here that needs a Kubernetes API server and a
        // mounted ServiceAccount token. KUBERNETES_SERVICE_HOST is injected by the kubelet into every
        // container and by nothing else, which makes it the one signal that cannot be true off a
        // cluster — so no hermetic test ever stands an election up, and none has to stub one out.
        //
        // Off-cluster the state therefore stays follower and this process dispatches nothing. That is
        // deliberate: this workload only ever runs in Kubernetes, and a local run that silently
        // elected itself would be a local run that sends real work to real processor queues.
        builder.Services.AddSingleton<LeaderState>();

        if (Environment.GetEnvironmentVariable("KUBERNETES_SERVICE_HOST") is not null)
        {
            builder.Services.AddHostedService<LeaderElectionService>();
        }

        // Loop 2 and its admission latch. The position of the next two lines is the point of them
        // being here at all: AddBaseConsoleGating below TryAdds AlwaysOpenAdmission as the default
        // IConsumerAdmission, and being above it is what turns that TryAdd into a no-op. Written
        // below instead, this plain AddSingleton would still be the one resolved — the container
        // returns the last registration for a single-service lookup — but the default would remain in
        // the collection, and the day either line becomes a TryAdd the latch loses to it without
        // failing and without logging, and the replica consumes announcements before it has mirrored
        // L2. One instance under two registrations, not two instances: the loop has to open the latch
        // the consumer reads.
        builder.Services.AddSingleton<HydrationAdmission>();
        builder.Services.AddSingleton<IConsumerAdmission>(
            sp => sp.GetRequiredService<HydrationAdmission>());

        // Hosted purely so the container constructs it; see the type's own remarks.
        builder.Services.AddHostedService<OrchestratorPipelineMetrics>();

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
                ["live"]))
            // And whether that loop has *finished*, which is a different question and belongs on a
            // different probe. The startup gate reports only that the loop is running — it has to, or
            // an outage this design rides out would exhaust the pod's finite startup budget — so
            // without this line "has this replica mirrored L2?" would have no probe at all.
            //
            // Tagged `ready` and nothing else. `live` would restart a replica for retrying exactly as
            // designed; `startup` would put it back under the budget that made this change necessary.
            // Readiness is the only probe that may sit red for the length of an outage and recover
            // without a restart. Nothing routes traffic here, so all it gates is the pod's READY
            // column, which is the intent: 0/1 means "still hydrating".
            .Add(new HealthCheckRegistration(
                HydrationReady,
                sp => new HydrationReadyHealthCheck(sp.GetRequiredService<HydrationAdmission>()),
                HealthStatus.Unhealthy,
                ["ready"]));

        // What makes "the queue exists before hydration reads L2" true. Opening the shared connection
        // is what declares topology, and the only other thing here that opens it is the gated
        // consumer, registered below and therefore started after this loop — so without this the
        // first pass read L2 through a queue that did not exist yet, and any announcement published
        // in that window was lost to this replica for good.
        builder.Services.AddSingleton<ITopologyDeclarer, ConnectionTopologyDeclarer>();

        // A plain type-based registration, not a factory: HydrationService's keyed ILoopHeartbeat
        // parameter carries [FromKeyedServices(HydrationService.LoopName)], which the built-in
        // container resolves on its own. The factory this replaced was shielding this loop's own
        // dependency graph from ValidateOnBuild — collapsing it puts HydrationService under the same
        // validation as everything else, including the IWorkflowScheduler registered above.
        builder.Services.AddHostedService<HydrationService>();

        // The two consumers that keep a running replica in step with L2 once hydration has admitted
        // it: the start and stop announcements the API publishes after each projection write. Scoped,
        // exactly as the processor registers ProcessDispatchHandler and ProcessedDataHandler — each
        // delivery resolves its own handler instance from its own scope.
        builder.Services.AddScoped<IQueueMessageHandler, ApplyStartHandler>();
        builder.Services.AddScoped<IQueueMessageHandler, ApplyStopHandler>();

        // The execution path's two handlers, registered the same way. Handlers are resolved by their
        // MessageType across the WHOLE container rather than per queue, so these four must stay
        // type-disjoint — two claiming one type makes the consumer's SingleOrDefault throw, which
        // classifies as deterministic and parks every message of that type.
        builder.Services.AddScoped<IQueueMessageHandler, StepOutcomeHandler>();
        builder.Services.AddScoped<IQueueMessageHandler, NextStepHandoffHandler>();

        // The announcement queue, which also registers the gate, its probe, the liveness check over
        // that probe, and the first consumer. It has to come before the AddGatedQueue calls below,
        // which reuse all of that and register only a consumer.
        builder.Services.AddBaseConsoleGating(
            builder.Configuration, OrchestratorFanout.PerReplica(instanceId.Value));

        // The execution path. Both are SHARED queues — one name for the deployment, every replica a
        // competing consumer — where the announcement queue above is per-replica. They inherit the
        // hydration latch along with the gate, which is what stops this replica taking a result for a
        // workflow it has not mirrored out of L2 yet.
        builder.Services.AddGatedQueue(OrchestratorQueues.Result);
        builder.Services.AddGatedQueue(OrchestratorQueues.ResultPost);

        return builder.Build();
    }
}
