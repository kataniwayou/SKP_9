using BaseConsole.Core.Health;
using BaseConsole.Core.Messaging;
using Orchestrator;
using Orchestrator.Hydration;
using Orchestrator.Messaging;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// A composition root fails at resolution time, not compile time, so the graph actually building is
/// the one thing worth asserting about a shell — the same idiom as <c>ProcessorSampleTests</c> on the
/// processor side.
/// </summary>
public sealed class OrchestratorHostWiringTests
{
    private static IHost Build() => OrchestratorHost.Create(
        // Development turns on the container's build-time validation, so every registration is
        // checked for constructibility without anything being instantiated — no broker or store is
        // contacted, because both RabbitMqConnection and the Redis multiplexer connect lazily.
        ["--environment", "Development"],
        cfg => cfg.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Service:Name"]            = "orchestrator",
            ["Service:Version"]         = "0.0.0",
            ["ConnectionStrings:Redis"] = "localhost:6379,abortConnect=false",
            ["RabbitMq:Host"]           = "localhost",
            ["RabbitMq:Username"]       = "guest",
            ["RabbitMq:Password"]       = "guest",
        }));

    [Fact]
    public void TheHostGraphResolves()
    {
        using var host = Build();

        Assert.NotNull(host);
    }

    [Fact]
    public void TheReplicaIdentityResolves()
    {
        using var host = Build();

        Assert.NotNull(host.Services.GetRequiredService<InstanceId>());
    }

    [Fact]
    public void TheTopologyIsRegistered()
    {
        using var host = Build();

        Assert.Contains(host.Services.GetServices<IRabbitMqTopology>(), t => t is OrchestratorTopology);
    }

    [Fact]
    public void AdmissionIsTheHydrationLatchAndNotTheAlwaysOpenDefault()
    {
        // The one wiring mistake in this host that fails in complete silence. AddBaseConsoleGating
        // resolves IConsumerAdmission with TryAddSingleton, so a HydrationAdmission registered after
        // it would simply lose to AlwaysOpenAdmission — no error, no log, and a replica that consumes
        // announcements before it has mirrored L2. Nothing else in the suite can see that happen.
        using var host = Build();

        Assert.IsType<HydrationAdmission>(host.Services.GetRequiredService<IConsumerAdmission>());
    }

    [Fact]
    public void TheAdmissionTheLoopOpensIsTheOneTheConsumerReads()
    {
        // Two registrations, one instance. Registering the concrete type and the interface separately
        // would give the hydration loop a latch of its own to open while the gated consumer went on
        // reading a second one that never opens — a deadlock in which the queue fills forever.
        using var host = Build();

        Assert.Same(
            host.Services.GetRequiredService<HydrationAdmission>(),
            host.Services.GetRequiredService<IConsumerAdmission>());
    }

    [Fact]
    public void TheHydrationLoopIsWatchedForLiveness()
    {
        // A heartbeat nobody reads proves nothing. A wedged hydration loop never opens the admission,
        // so the queue fills forever while every probe stays green — and nothing inside the process
        // can restart a loop that is gone, which is why `live` is the tag and the only one.
        using var host = Build();

        var registration = Assert.Single(
            host.Services.GetRequiredService<IOptions<HealthCheckServiceOptions>>().Value.Registrations,
            r => r.Name == OrchestratorHost.HydrationLoop);

        Assert.Equal(["live"], registration.Tags);
        Assert.Equal(HealthStatus.Unhealthy, registration.FailureStatus);

        // Constructing it is what proves the keyed heartbeat resolves. An unkeyed lookup here would
        // fail to resolve at startup, and this is the only place that would say so.
        Assert.IsType<LoopLivenessHealthCheck>(registration.Factory(host.Services));
    }

    [Fact]
    public void TheHealthSurfaceIsRegistered()
    {
        // This asserted `EmbeddedHealthEndpointService` is among IHostedService until Loop 2 arrived.
        // It cannot any more: the hydration loop is a hosted service too, and enumerating that service
        // constructs every one of them — including a WorkflowActivator whose IWorkflowScheduler is a
        // WorkflowScheduler<TJob> closed over a fire job that does not exist yet. So the health
        // surface is asserted through the registrations AddBaseConsoleHealth makes instead, which is
        // the same claim by a route the still-incomplete scheduling stack cannot break. The
        // enumeration belongs back here, as an EveryLoopIsHosted, the moment the graph can be started.
        using var host = Build();

        var registrations = host.Services
            .GetRequiredService<IOptions<HealthCheckServiceOptions>>().Value.Registrations;

        Assert.NotNull(host.Services.GetRequiredService<IStartupGate>());
        Assert.Contains(registrations, r => r.Name == "self");
        Assert.Contains(registrations, r => r.Name == "startup");
    }
}
