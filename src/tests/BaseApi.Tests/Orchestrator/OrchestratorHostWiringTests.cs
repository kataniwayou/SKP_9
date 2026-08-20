using BaseConsole.Core.Health;
using BaseConsole.Core.Messaging;
using Orchestrator;
using Orchestrator.Messaging;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
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
    public void GatingDefaultsToTheAlwaysOpenAdmission()
    {
        // Task 3's default. A later task registers a hydration-backed IConsumerAdmission ahead of
        // AddBaseConsoleGating's TryAddSingleton; until then this shell gets the default.
        using var host = Build();

        Assert.IsType<AlwaysOpenAdmission>(host.Services.GetRequiredService<IConsumerAdmission>());
    }

    [Fact]
    public void TheHealthEndpointIsHosted()
    {
        using var host = Build();

        Assert.Contains(
            host.Services.GetServices<IHostedService>(), h => h is EmbeddedHealthEndpointService);
    }
}
