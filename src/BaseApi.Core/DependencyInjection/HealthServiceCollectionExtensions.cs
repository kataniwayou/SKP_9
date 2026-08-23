using BaseApi.Core.Configuration;
using BaseApi.Core.Diagnostics;
using BaseApi.Core.Gating;
using BaseApi.Core.Health;
using BaseApi.Core.Messaging;
using HealthChecks.NpgSql;
using Messaging.Transport;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace BaseApi.Core.DependencyInjection;

/// <summary>
/// Health wiring: the startup gate, the live/startup/ready check chain, and the hosted service that
/// flips the gate once the host has started.
///
/// <para>
/// <b>Readiness answers one question: can this pod serve HTTP?</b> That makes Postgres a required,
/// latched dependency — without it no request can be served — and it is wrapped in a per-process
/// sticky latch so a sustained failure keeps readiness unhealthy until restart rather than letting a
/// dead pod flap back into rotation.
/// </para>
///
/// <para>
/// <b>Redis is deliberately NOT latched, and is capped at degraded.</b> It used to be a latched
/// required dependency, and that is incompatible with pausing consumption to ride out an outage: the
/// latch flips after a handful of consecutive failures and never self-heals, so an outage lasting
/// under a minute would take the pod out of the service permanently — while the consumer behind it
/// recovered and drained its queue perfectly well. The pod would be simultaneously working and
/// unreachable. Redis is a hard dependency for individual request paths, which report their own
/// failures, and not for the service.
/// </para>
///
/// <para>
/// <b>Liveness carries the probe-loop watchdog, and nothing dependency-shaped.</b> The loop is the
/// only thing that can reopen the gate after an outage, and nothing inside the process can restart it
/// once it has stopped — so a stalled loop must be recoverable only by an external restart, which is
/// what liveness triggers. It reports staleness of the loop itself, never the state of the gate: a
/// closed gate is the system working, and failing liveness on it would restart the pod during exactly
/// the outage the gate exists to survive.
/// </para>
/// </summary>
internal static class HealthServiceCollectionExtensions
{
    // Default readiness failure threshold, matching the readiness probe's failureThreshold in the
    // deployment manifest. The latch flips after this many consecutive unhealthy evaluations.
    private const int DefaultReadinessFailureThreshold = 5;

    private const string PostgresLatchKey = "baseapi-ready-postgres";

    internal static IServiceCollection AddBaseApiHealth(
        this IServiceCollection services, IConfiguration cfg)
    {
        services.AddSingleton<IStartupGate, StartupGate>();
        services.AddSingleton<IMigrationState, MigrationState>();
        services.TryAddSingleton<IMigrationRunner, MigrationRunner>();
        services.TryAddSingleton(TimeProvider.System);

        // Fail fast on a missing connection string rather than letting null reach the Postgres check.
        var postgresConnStr = cfg.RequireConnectionString("Postgres");
        var failureThreshold =
            cfg.GetValue<int?>("Health:ReadinessFailureThreshold") ?? DefaultReadinessFailureThreshold;

        // Registered as a singleton so the reference is stable and never disposed mid-probe.
        services.AddSingleton(sp => new ApiRedisReadyHealthCheck(sp));

        // Per-process singleton latch — the latch state must persist across probe polls, so it is
        // never constructed per check.
        // The latch exists so a pod whose Postgres is gone for good does not flap back into rotation.
        // It must not fire for an outage that is recovering on its own, though — latching a transient
        // fault manufactures the restart requirement the three-state verdict exists to avoid — so it
        // latches only on a verdict an operator actually has to act on.
        services.AddKeyedSingleton(PostgresLatchKey, (sp, _) => new ApiLatchedReadinessHealthCheck(
            new NpgSqlHealthCheck(new NpgSqlHealthCheckOptions(postgresConnStr)),
            failureThreshold,
            static ex => ex is not null
                         && PostgresFaultClassifier.Classify(ex).Fault != DependencyFault.Transient));

        services.AddHealthChecks()
            .AddCheck("self", () => HealthCheckResult.Healthy(), tags: new[] { "live" })
            // `startup` only. The gate now means "the migration loop is running", not "the schema is
            // applied" — see StartupHealthCheck. Leaving it on `ready` too would make readiness green
            // before the schema existed.
            .AddCheck<StartupHealthCheck>("startup", tags: new[] { "startup" })
            // The claim the startup probe used to make, moved to the probe that can afford to make it:
            // readiness has no budget to exhaust, so it can stay red for the length of an outage and
            // recover without a restart.
            .Add(new HealthCheckRegistration(
                "migrations",
                sp => new MigrationReadyHealthCheck(sp.GetRequiredService<IMigrationState>()),
                failureStatus: null,
                tags: new[] { "ready" }))
            // The factory resolves the per-process singleton latch, so its sticky state survives every
            // poll. The name stays "npgsql" to preserve the readiness response body contract.
            .Add(new HealthCheckRegistration(
                "npgsql",
                sp => sp.GetRequiredKeyedService<ApiLatchedReadinessHealthCheck>(PostgresLatchKey),
                failureStatus: null,
                tags: new[] { "ready" }))
            // Unlatched and capped at degraded: visible on the readiness body without being able to
            // fail it. See the type remarks for why latching this one was actively harmful.
            .Add(new HealthCheckRegistration(
                "redis",
                sp => sp.GetRequiredService<ApiRedisReadyHealthCheck>(),
                failureStatus: HealthStatus.Degraded,
                tags: new[] { "ready" }))
            // Same treatment, same reasoning: the broker is a hard dependency for the control paths
            // and no dependency at all for CRUD.
            .Add(new HealthCheckRegistration(
                "broker",
                sp => new BrokerHealthCheck(sp.GetRequiredService<RabbitMqConnection>()),
                failureStatus: HealthStatus.Degraded,
                tags: new[] { "ready" }))
            // Liveness. Unhealthy here means the pod gets restarted, which is the only repair
            // available for a loop that has stopped iterating.
            .Add(new HealthCheckRegistration(
                "probe-loop",
                sp => new LoopLivenessHealthCheck(
                    sp.GetRequiredService<ILoopHeartbeat>(),
                    sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<L2GateOptions>>(),
                    sp.GetRequiredService<TimeProvider>()),
                failureStatus: HealthStatus.Unhealthy,
                tags: new[] { "live" }));

        services.AddHostedService<StartupCompletionService>();
        return services;
    }
}
