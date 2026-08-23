using BaseApi.Core.DependencyInjection;
using BaseApi.Core.Health;
using BaseApi.Service;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Xunit;

namespace BaseApi.Tests.DependencyInjection;

/// <summary>
/// The preflight leads <c>AddBaseApi</c>'s chain, and that position is load-bearing rather than
/// cosmetic: hosted services start in registration order, so anything registered ahead of the
/// preflight logs ahead of it. <see cref="StartupCompletionService"/> in particular runs migrations
/// and can sit on an unreachable Postgres for a full connect timeout — put the preflight behind it
/// and the answer to "can this process reach anything?" arrives after the wait it would have
/// explained.
/// <para>
/// <b>Why this asserts on descriptors rather than on a built provider.</b> Building the provider
/// would run the real <c>ConnectionMultiplexer.Connect</c> factory against a real socket, which is the
/// same reason <see cref="ApiRedisConnectionOptionsTests"/> tests its wrapper directly.
/// </para>
/// <para>
/// <b>Why the preflight is identified by shape and not by type.</b> It is registered through a factory
/// — it needs a redacted endpoint string that is computed at wiring time — so its descriptor carries
/// an <c>ImplementationFactory</c> and a null <c>ImplementationType</c>. Invoking that factory to name
/// the type would construct the service and resolve its dependencies, which is the very thing this
/// test avoids.
/// </para>
/// </summary>
public sealed class PreflightRegistrationOrderTests
{
    private static ServiceCollection Compose()
    {
        var cfg = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:Postgres"] = "Host=pg;Database=db;Username=u;Password=p",
                ["ConnectionStrings:Redis"]    = "redis-host:6379,abortConnect=false",
            })
            .Build();

        var services = new ServiceCollection();
        services.AddBaseApi<AppDbContext>(cfg);
        return services;
    }

    [Fact]
    public void ThePreflightIsTheFirstHostedServiceRegistered()
    {
        var hosted = Compose()
            .Where(d => d.ServiceType == typeof(IHostedService))
            .ToList();

        Assert.NotEmpty(hosted);
        Assert.Null(hosted[0].ImplementationType);
        Assert.NotNull(hosted[0].ImplementationFactory);
    }

    [Fact]
    public void MigrationRunsAfterThePreflightHasHadItsSay()
    {
        var hosted = Compose()
            .Where(d => d.ServiceType == typeof(IHostedService))
            .ToList();

        var migration = hosted.FindIndex(d => d.ImplementationType == typeof(StartupCompletionService));

        Assert.True(migration > 0,
            "StartupCompletionService must not be the first hosted service: it runs migrations and "
            + "can block on an unreachable Postgres for a whole connect timeout, which would delay "
            + "the preflight output that explains the wait.");
    }

    [Fact]
    public void ExactlyOnePreflightIsRegistered()
    {
        // Two would double every line an operator reads at startup, and the duplicate would come from
        // AddBaseApiPreflight being called both in the chain and by hand.
        var factoryHosted = Compose()
            .Count(d => d.ServiceType == typeof(IHostedService) && d.ImplementationType is null);

        Assert.Equal(1, factoryHosted);
    }
}
