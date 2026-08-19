using BaseConsole.Core.Health;
using BaseConsole.Core.Loop;
using BaseConsole.Core.Messaging;
using BaseProcessor.Core.DependencyInjection;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Liveness;
using BaseProcessor.Core.Startup;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using NSubstitute;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Processor;

/// <summary>
/// A composition root fails at resolution time, not compile time, so the graph actually building is
/// the thing worth asserting.
/// </summary>
public sealed class ProcessorHostWiringTests
{
    // ReplyQueueConsumer implements only IAsyncDisposable, so every test disposes the provider with
    // `await using` — a synchronous Dispose on a container holding one throws.
    private static ServiceProvider Build()
    {
        var services = new ServiceCollection();
        services.AddLogging();

        // Substituted before AddBaseProcessor so TryAdd leaves them alone: resolving the real
        // multiplexer would open a connection, and the point here is the shape of the graph.
        services.AddSingleton(Substitute.For<IConnectionMultiplexer>());
        services.AddSingleton<IEnumerable<IRabbitMqTopology>>([]);

        // AddBaseProcessor folds the console base, so the settings it reads eagerly must be present.
        var cfg = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Redis"] = "localhost:6379,abortConnect=false",
            ["RabbitMq:Host"]           = "localhost",
            ["RabbitMq:Username"]       = "guest",
            ["RabbitMq:Password"]       = "guest",
        }).Build();

        services.AddBaseProcessor(cfg);
        return services.BuildServiceProvider(validateScopes: true);
    }

    [Fact]
    public async Task EverySingletonResolves()
    {
        await using var sp = Build();

        Assert.NotNull(sp.GetRequiredService<IProcessorContext>());
        Assert.NotNull(sp.GetRequiredService<ISourceHashProvider>());
        Assert.NotNull(sp.GetRequiredService<ProcessorLivenessWriter>());
        Assert.NotNull(sp.GetRequiredService<ReplySlot<object>>());
        Assert.NotNull(sp.GetRequiredService<InstanceId>());
    }

    [Fact]
    public async Task TheConsoleBaseIsFoldedInSoAShellNeedsOneCall()
    {
        // A concrete processor should not have to remember the broker, Redis and the health surface —
        // each omission would be a runtime failure rather than a compile error.
        await using var sp = Build();

        Assert.NotNull(sp.GetRequiredService<IQueueSender>());
        Assert.NotNull(sp.GetRequiredService<RabbitMqConnection>());
        Assert.NotNull(sp.GetRequiredService<IStartupGate>());
        Assert.Contains(sp.GetServices<IHostedService>(), h => h is EmbeddedHealthEndpointService);
    }

    [Fact]
    public async Task TheReplyEndpointIsTheConsumerThatServesIt()
    {
        // Handing out a ReplyTo naming a queue nobody is consuming would strand every answer.
        await using var sp = Build();

        Assert.Same(
            sp.GetRequiredService<ReplyQueueConsumer>(),
            sp.GetRequiredService<IReplyEndpoint>());
    }

    [Fact]
    public async Task BothLoopsRunAsHostedServices()
    {
        await using var sp = Build();

        var hosted = sp.GetServices<IHostedService>().ToList();
        Assert.Contains(hosted, h => h is ProcessorStartupOrchestrator);
        Assert.Contains(hosted, h => h is ProcessorLivenessHeartbeat);
    }

    [Fact]
    public async Task EachLoopGetsItsOwnHeartbeatHolder()
    {
        // A shared holder would let either loop's beat mask the other's death.
        await using var sp = Build();

        var startup = sp.GetRequiredKeyedService<ILoopHeartbeat>(
            BaseProcessorServiceCollectionExtensions.StartupLoop);
        var liveness = sp.GetRequiredKeyedService<ILoopHeartbeat>(
            BaseProcessorServiceCollectionExtensions.LivenessLoop);

        Assert.NotSame(startup, liveness);
    }

    [Fact]
    public async Task TheTwoLoopChecksAreRegisteredSeparatelyUnderLive()
    {
        await using var sp = Build();

        var names = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<HealthCheckServiceOptions>>()
            .Value.Registrations;

        Assert.Contains(names, r => r.Name == "processor-startup-loop" && r.Tags.Contains("live"));
        Assert.Contains(names, r => r.Name == "processor-liveness-loop" && r.Tags.Contains("live"));
        Assert.Contains(names, r => r.Name == "processor-identity-ready" && r.Tags.Contains("ready"));
    }
}
