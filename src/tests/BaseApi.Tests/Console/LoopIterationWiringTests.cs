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

[Collection(EnvironmentCollection.Name)]
public sealed class LoopIterationWiringTests
{
    /// <summary>
    /// The running iteration total for one loop, as one poll sees it.
    /// <para>
    /// <b>A fresh collector per call, and a delta rather than a set.</b> These are the production
    /// loop names, the registry behind them is process-wide, and other tests in this assembly beat
    /// the same names -- so no absolute reading is attributable to this test. The count is an
    /// observable, so a reused collector would also fold every earlier poll into the list.
    /// </para>
    /// </summary>
    private static double IterationsFor(string loop)
    {
        using var metrics = new MetricCollector(CountingLoopHeartbeat.MeterName);
        metrics.Collect();
        return metrics.For(CountingLoopHeartbeat.IterationsInstrument)
            .Where(m => m.Tags["loop"] == loop)
            .Sum(m => m.Value);
    }

    /// <summary>Whether any measurement is reported for <paramref name="loop"/> at all.</summary>
    private static bool IsReported(string loop)
    {
        using var metrics = new MetricCollector(CountingLoopHeartbeat.MeterName);
        metrics.Collect();
        return metrics.For(CountingLoopHeartbeat.IterationsInstrument)
            .Any(m => m.Tags["loop"] == loop);
    }

    /// <summary>
    /// Builds a container through the production gate registration.
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
    /// Builds a container through the production processor registration.
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
        using var sp = BuildGateContainer();
        var heartbeat = sp.GetRequiredKeyedService<ILoopHeartbeat>(
            ConsoleRedisServiceCollectionExtensions.GateLoop);

        // Constructing the heartbeat seeded the name, so it reports before a single beat. The key
        // must be the same string the LoopLivenessHealthCheck uses, or a rate panel and a failing
        // probe name two different loops.
        Assert.True(IsReported("l2-gate"));

        var before = IterationsFor("l2-gate");

        heartbeat.Beat();

        Assert.Equal(before + 1, IterationsFor("l2-gate"));
    }

    [Fact]
    public void TheLivenessLoopsBeatIsCounted()
    {
        using var sp = BuildProcessorContainer();
        var heartbeat = sp.GetRequiredKeyedService<ILoopHeartbeat>(
            BaseProcessorServiceCollectionExtensions.LivenessLoop);

        // Seeded at construction, then one per beat.
        Assert.True(IsReported("processor-liveness"));

        var before = IterationsFor("processor-liveness");

        heartbeat.Beat();

        Assert.Equal(before + 1, IterationsFor("processor-liveness"));
    }

    [Fact]
    public void TheStartupLoopsBeatIsNotCounted()
    {
        // It retires the moment Loop B resolves the last schema, so its rate would sit at zero
        // for the life of the process and mean nothing. Registering it would put a permanently
        // flat line on the loop-rate panel, which is one more thing teaching an operator that
        // the panel is always the same.
        //
        using var sp = BuildProcessorContainer();
        var heartbeat = sp.GetRequiredKeyedService<ILoopHeartbeat>(
            BaseProcessorServiceCollectionExtensions.StartupLoop);

        heartbeat.Beat();

        // Nothing reported for this loop at all. If the startup loop were wrapped, its construction
        // would seed the name and a poll would report it, so this assertion would fail. The poll is
        // what makes that true: an observable publishes nothing until asked, and a reading taken
        // without one is empty no matter how the wiring is built.
        Assert.False(IsReported("processor-startup"));
    }
}
