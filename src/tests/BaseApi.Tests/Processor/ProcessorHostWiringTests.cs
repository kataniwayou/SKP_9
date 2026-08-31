using BaseConsole.Core.Health;
using BaseConsole.Core.Loop;
using BaseConsole.Core.Messaging;
using BaseProcessor.Core.DependencyInjection;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Liveness;
using BaseProcessor.Core.Startup;
using Messaging.Contracts;
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

    /// <summary>
    /// The id every processor queue name is derived from. A fixed value rather than a fresh Guid so
    /// a failure names the same queue twice running.
    /// </summary>
    private static readonly ProcessorIdentityFound Identity = new(
        Guid.Parse("11111111-2222-3333-4444-555555555555"), null, null, null, "sample", "1.0.0");

    /// <summary>
    /// The Stage-2 graph, which is a different graph: the one-argument <c>AddBaseProcessor</c> that
    /// <see cref="Build"/> uses does not call <c>AddProcessorExecution</c> at all, so the work queue,
    /// its topology and both probes exist only here.
    /// </summary>
    private static ServiceProvider BuildWithIdentity()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton(Substitute.For<IConnectionMultiplexer>());
        services.AddSingleton<IEnumerable<IRabbitMqTopology>>([]);

        var cfg = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Redis"] = "localhost:6379,abortConnect=false",
            ["RabbitMq:Host"]           = "localhost",
            ["RabbitMq:Username"]       = "guest",
            ["RabbitMq:Password"]       = "guest",
        }).Build();

        services.AddBaseProcessor(cfg, Identity);
        return services.BuildServiceProvider(validateScopes: true);
    }

    [Fact]
    public async Task TheHostGraphCarriesNoSourceHashProvider()
    {
        // The hash answers "which row is mine", and that is settled before this container exists —
        // Stage 1 owns it and registers its own. A copy here would resolve for nobody while reading
        // like a live dependency, which is how a graph accumulates wiring nobody dares delete.
        await using var sp = Build();

        Assert.Null(sp.GetService<ISourceHashProvider>());
    }

    [Fact]
    public async Task EverySingletonResolves()
    {
        await using var sp = Build();

        Assert.NotNull(sp.GetRequiredService<IProcessorContext>());
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
    public async Task BothQueueProbesRunAsHostedServices()
    {
        // These two answer different questions -- what is WAITING and what was REFUSED -- and both
        // are invisible from outside the process when absent. A missing dead-letter probe is the
        // worse of the two: the processor board's `Dead-lettered` stat and `Dead-letter depth by
        // queue` panel are emitted from the same shared function as the orchestrator's and have
        // always been there, so without this registration they render a confident zero rather than
        // no data. An absent series and an empty queue are the same picture, and the board shows
        // the reassuring one.
        //
        // Enumerating IHostedService constructs every one of them, which is the point: a probe that
        // resolved but was never hosted would leave the panels exactly as blind.
        await using var sp = BuildWithIdentity();

        var hosted = sp.GetServices<IHostedService>().ToList();
        Assert.Contains(hosted, h => h is QueueDepthProbe);
        Assert.Contains(hosted, h => h is DeadLetterDepthProbe);
    }

    [Fact]
    public async Task BothQueuesGetTheirOwnGatedConsumer()
    {
        // TWO consumers, one per queue, and the count is the assertion. AddGatedQueue's own remarks
        // spell out the trap this guards: AddHostedService registers through TryAddEnumerable, which
        // de-duplicates on IMPLEMENTATION TYPE -- so a second registration naming GatedQueueConsumer
        // would be silently dropped, the post queue would never be consumed, and nothing anywhere
        // would say so. Branches would pile up on a queue with no consumer while every probe stayed
        // green.
        //
        // A count rather than a Contains: one consumer satisfies Contains just as well as two, which
        // is precisely the failure being guarded against.
        await using var sp = BuildWithIdentity();

        var consumers = sp.GetServices<IHostedService>().OfType<GatedQueueConsumer>().ToList();

        Assert.Equal(2, consumers.Count);
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

    [Fact]
    public async Task TheQueueDepthLoopCheckIsRegisteredUnderLive()
    {
        // Stage-2 graph, deliberately: this check's factory reads the QueueDepthLoop-keyed
        // heartbeat that only AddProcessorExecution registers. Asserting against Build() (the
        // 1-arg graph) would prove nothing about the check that actually ships -- and would have
        // hidden the InvalidOperationException a resolve on that graph used to throw.
        await using var sp = BuildWithIdentity();

        var names = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<HealthCheckServiceOptions>>()
            .Value.Registrations;

        Assert.Contains(
            names,
            r => r.Name == BaseProcessorServiceCollectionExtensions.QueueDepthLoop
                 && r.Tags.Contains("live")
                 && r.FailureStatus == HealthStatus.Unhealthy);
    }

    [Fact]
    public async Task TheQueueDepthLoopGetsItsOwnHeartbeatHolderToo()
    {
        // Same invariant as EachLoopGetsItsOwnHeartbeatHolder, extended to the third loop: a holder
        // shared with either of the other two would let a faster loop's beat mask this one's death.
        await using var sp = BuildWithIdentity();

        var startup = sp.GetRequiredKeyedService<ILoopHeartbeat>(
            BaseProcessorServiceCollectionExtensions.StartupLoop);
        var liveness = sp.GetRequiredKeyedService<ILoopHeartbeat>(
            BaseProcessorServiceCollectionExtensions.LivenessLoop);
        var queueDepth = sp.GetRequiredKeyedService<ILoopHeartbeat>(
            BaseProcessorServiceCollectionExtensions.QueueDepthLoop);

        Assert.NotSame(startup, queueDepth);
        Assert.NotSame(liveness, queueDepth);
    }
}
