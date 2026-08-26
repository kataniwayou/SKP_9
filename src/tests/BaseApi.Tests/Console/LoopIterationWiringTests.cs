using BaseApi.Tests.Support;
using BaseConsole.Core.DependencyInjection;
using BaseConsole.Core.Loop;
using BaseProcessor.Core.DependencyInjection;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using NSubstitute;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Console;

public sealed class LoopIterationWiringTests
{
    /// <summary>
    /// Builds a container through the production gate registration. A collector created
    /// before resolution catches the heartbeat's construction-time seed.
    /// </summary>
    private static ServiceProvider BuildGateContainer()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<TimeProvider>(TimeProvider.System);

        var cfg = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>()).Build();
        services.AddBaseConsoleGating(cfg, "some-work-queue");

        return services.BuildServiceProvider(validateScopes: true);
    }

    /// <summary>
    /// Builds a container through the production processor registration. A collector created
    /// before resolution catches each heartbeat's construction-time seed.
    /// </summary>
    private static ServiceProvider BuildProcessorContainer()
    {
        var services = new ServiceCollection();
        services.AddLogging();

        // Substituted so TryAdd leaves it alone; resolving the real multiplexer would open a connection.
        services.AddSingleton(Substitute.For<IConnectionMultiplexer>());
        services.AddSingleton<IEnumerable<IRabbitMqTopology>>([]);

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
    public void TheGateLoopsBeatIsCounted()
    {
        // Create the collector BEFORE resolving, so the heartbeat's construction-time seed is caught.
        using var metrics = new MetricCollector(CountingLoopHeartbeat.MeterName);

        using var sp = BuildGateContainer();
        var heartbeat = sp.GetRequiredKeyedService<ILoopHeartbeat>(
            ConsoleRedisServiceCollectionExtensions.GateLoop);

        heartbeat.Beat();

        var mine = metrics.For(CountingLoopHeartbeat.IterationsInstrument)
            .Where(m => m.Tags["loop"] == "l2-gate")
            .Select(m => m.Value)
            .ToList();

        // The seed at construction, then the beat. The key on the counter must be the same
        // string the LoopLivenessHealthCheck uses, or a rate panel and a failing probe name
        // two different loops.
        Assert.Equal([0d, 1d], mine);
    }

    [Fact]
    public void TheLivenessLoopsBeatIsCounted()
    {
        // Create the collector BEFORE resolving, so the heartbeat's construction-time seed is caught.
        using var metrics = new MetricCollector(CountingLoopHeartbeat.MeterName);

        using var sp = BuildProcessorContainer();
        var heartbeat = sp.GetRequiredKeyedService<ILoopHeartbeat>(
            BaseProcessorServiceCollectionExtensions.LivenessLoop);

        heartbeat.Beat();

        var mine = metrics.For(CountingLoopHeartbeat.IterationsInstrument)
            .Where(m => m.Tags["loop"] == "processor-liveness")
            .Select(m => m.Value)
            .ToList();

        // The seed at construction, then the beat.
        Assert.Equal([0d, 1d], mine);
    }

    [Fact]
    public void TheStartupLoopsBeatIsNotCounted()
    {
        // It retires the moment Loop B resolves the last schema, so its rate would sit at zero
        // for the life of the process and mean nothing. Registering it would put a permanently
        // flat line on the loop-rate panel, which is one more thing teaching an operator that
        // the panel is always the same.
        //
        // Create the collector BEFORE resolving, so we catch any wrongly-wrapped heartbeat's seed.
        using var metrics = new MetricCollector(CountingLoopHeartbeat.MeterName);

        using var sp = BuildProcessorContainer();
        var heartbeat = sp.GetRequiredKeyedService<ILoopHeartbeat>(
            BaseProcessorServiceCollectionExtensions.StartupLoop);

        heartbeat.Beat();

        var mine = metrics.For(CountingLoopHeartbeat.IterationsInstrument)
            .Where(m => m.Tags["loop"] == "processor-startup")
            .ToList();

        // No measurements tagged with this loop. If the startup loop were wrapped, its
        // construction would seed a 0 measurement, and this assertion would fail.
        Assert.Empty(mine);
    }
}
