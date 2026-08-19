using BaseConsole.Core.Health;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace BaseConsole.Core.DependencyInjection;

/// <summary>
/// The worker's health surface: the startup latch, the two checks every console has regardless of
/// what it does, and the listener that exposes them to the kubelet.
/// <para>
/// Only <c>self</c> is tagged <c>live</c> here. A worker that has loops worth watching adds its own
/// <c>live</c>-tagged checks — one per loop — and they are picked up automatically, because the
/// listener filters the host's own registrations by tag rather than keeping a second list.
/// </para>
/// </summary>
public static class ConsoleHealthServiceCollectionExtensions
{
    public static IServiceCollection AddBaseConsoleHealth(
        this IServiceCollection services, IConfiguration cfg)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(cfg);

        services.Configure<ConsoleHealthOptions>(cfg.GetSection("ConsoleHealth"));
        services.TryAddSingleton<IStartupGate, StartupGate>();

        services.AddHealthChecks()
            // Answers that the process is up and serving HTTP, and nothing more. Liveness must never
            // consult a dependency: a blip that failed it would restart every replica during the
            // outage they are supposed to ride out.
            .AddCheck("self", () => HealthCheckResult.Healthy(), tags: ["live"])
            .AddCheck<StartupHealthCheck>("startup", tags: ["startup"]);

        services.AddHostedService<EmbeddedHealthEndpointService>();

        return services;
    }
}
