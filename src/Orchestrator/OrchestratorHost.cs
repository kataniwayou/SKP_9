using BaseConsole.Core.DependencyInjection;
using BaseConsole.Core.Messaging;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
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
/// <b>Registrations run in a flat, ordered block rather than a fluent chain</b> so that a later task
/// can insert a line ahead of <see cref="ConsoleRedisServiceCollectionExtensions.AddBaseConsoleGating"/>
/// without restructuring anything around it — that is exactly where the hydration-backed
/// <c>IConsumerAdmission</c> a later task adds must land, since gating resolves it with
/// <c>TryAddSingleton</c> and the first registration wins.
/// </para>
/// </summary>
public static class OrchestratorHost
{
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

        // A later task's hydration-backed IConsumerAdmission registers directly above this call — see
        // the type remarks — so that AddBaseConsoleGating's TryAddSingleton<IConsumerAdmission> leaves
        // it alone instead of falling back to AlwaysOpenAdmission.
        builder.Services.AddBaseConsoleGating(
            builder.Configuration, OrchestratorFanout.PerReplica(instanceId.Value));

        return builder.Build();
    }
}
