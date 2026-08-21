using BaseConsole.Core.DependencyInjection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Xunit;

namespace BaseApi.Tests.Console;

/// <summary>
/// The registration shape only. Nothing here builds a <see cref="ServiceProvider"/> or resolves
/// <see cref="IHostedService"/> — doing so would run <c>AddBaseConsoleRedis</c>'s
/// <c>ConnectionMultiplexer.Connect</c> factory, which reaches for a real socket. See
/// <c>ConsoleGatingWiringTests</c> for the same constraint on the neighbouring extension.
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
}
