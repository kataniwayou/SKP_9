using BaseConsole.Core.DependencyInjection;
using BaseConsole.Core.Loop;
using BaseProcessor.Core.DependencyInjection;
using BaseProcessor.Core.Startup;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Orchestrator.Hydration;
using Xunit;

namespace BaseApi.Tests.Console;

/// <summary>
/// The registration shape only. Nothing here builds a <see cref="ServiceProvider"/> or resolves
/// <see cref="IHostedService"/> — doing so would run <c>AddBaseConsoleRedis</c>'s
/// <c>ConnectionMultiplexer.Connect</c> factory, which reaches for a real socket. See
/// <c>ConsoleGatingWiringTests</c> for the same constraint on the neighbouring extension.
/// <para>
/// The two ordering tests exist because "its output leads the console" — the entire reason the
/// preflight is registered where it is in <c>OrchestratorHost</c> and
/// <c>BaseProcessorServiceCollectionExtensions</c> — was previously enforced only by a comment at each
/// call site. They replay the exact <c>AddHostedService</c> call each host makes for its own startup
/// loop, immediately after <c>AddBaseConsolePreflight</c>, and check descriptor order — never
/// resolving anything, so no real connection is ever attempted.
/// </para>
/// </summary>
public sealed class ConsolePreflightWiringTests
{
    private static IConfiguration Configure(bool includeRedisConnectionString = true)
    {
        var data = new Dictionary<string, string?>
        {
            ["RabbitMq:Host"]     = "rmq-host",
            ["RabbitMq:Username"] = "svc-user",
            ["RabbitMq:Password"] = "secret",
        };

        if (includeRedisConnectionString)
        {
            data["ConnectionStrings:Redis"] = "redis-host:6379,password=secret,abortConnect=false";
        }

        return new ConfigurationBuilder().AddInMemoryCollection(data).Build();
    }

    [Fact]
    public void RegistersAHostedService()
    {
        var services = new ServiceCollection();
        var cfg = Configure();

        services.AddBaseConsoleMessaging(cfg);
        services.AddBaseConsoleRedis(cfg);
        services.AddBaseConsolePreflight(cfg);

        Assert.Contains(services, sd => sd.ServiceType == typeof(IHostedService));
    }

    [Fact]
    public void FailsFastWhenTheRedisConnectionStringIsMissing()
    {
        // Read eagerly, the same idiom AddBaseConsoleRedis itself already follows: a missing setting
        // is reported by name at wiring time, not the first time the loop tries to log an endpoint.
        var services = new ServiceCollection();
        var cfg = Configure(includeRedisConnectionString: false);

        var ex = Assert.Throws<InvalidOperationException>(() => services.AddBaseConsolePreflight(cfg));
        Assert.Contains("Redis", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RegistersBeforeHydrationServiceInTheOrchestratorsOwnRegistrationOrder()
    {
        var services = new ServiceCollection();
        var cfg = Configure();

        services.AddBaseConsoleMessaging(cfg);
        services.AddBaseConsoleRedis(cfg);
        services.AddBaseConsolePreflight(cfg);
        var preflightIndex = IndexOfOnlyHostedService(services);

        // The exact call OrchestratorHost.Create makes, later in the same method, for its own
        // startup loop.
        services.AddHostedService<HydrationService>();
        var hydrationIndex = LastIndexOfHostedService(services);

        Assert.True(
            preflightIndex < hydrationIndex,
            $"preflight at {preflightIndex}, HydrationService at {hydrationIndex}");
    }

    [Fact]
    public void RegistersBeforeProcessorStartupOrchestratorInTheProcessorsOwnRegistrationOrder()
    {
        var services = new ServiceCollection();
        var cfg = Configure();

        services.AddBaseConsoleMessaging(cfg);
        services.AddBaseConsoleRedis(cfg);
        services.AddBaseConsolePreflight(cfg);
        var preflightIndex = IndexOfOnlyHostedService(services);

        // The exact call AddBaseProcessor makes, later in the same method, for Loop B.
        services.AddHostedService(sp => ActivatorUtilities.CreateInstance<ProcessorStartupOrchestrator>(
            sp, sp.GetRequiredKeyedService<ILoopHeartbeat>(BaseProcessorServiceCollectionExtensions.StartupLoop)));
        var startupIndex = LastIndexOfHostedService(services);

        Assert.True(
            preflightIndex < startupIndex,
            $"preflight at {preflightIndex}, ProcessorStartupOrchestrator at {startupIndex}");
    }

    private static int IndexOfOnlyHostedService(ServiceCollection services)
    {
        var index = services.ToList().FindIndex(sd => sd.ServiceType == typeof(IHostedService));
        Assert.True(index >= 0, "expected exactly one IHostedService registration by this point");
        return index;
    }

    private static int LastIndexOfHostedService(ServiceCollection services) =>
        services.ToList().FindLastIndex(sd => sd.ServiceType == typeof(IHostedService));
}
