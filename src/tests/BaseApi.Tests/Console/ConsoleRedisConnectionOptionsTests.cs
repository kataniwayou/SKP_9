using BaseConsole.Core.DependencyInjection;
using Xunit;

namespace BaseApi.Tests.Console;

/// <summary>
/// <see cref="ConsoleRedisConnectionOptions"/> is the whole non-aborting-connect contract for
/// <c>AddBaseConsoleRedis</c>, tested directly. The wiring itself cannot be exercised through a built
/// <see cref="Microsoft.Extensions.DependencyInjection.ServiceProvider"/> — resolving
/// <see cref="Microsoft.Extensions.Hosting.IHostedService"/> would run the real
/// <c>ConnectionMultiplexer.Connect</c> factory against a real socket. See
/// <c>ConsolePreflightWiringTests</c> for the same constraint on the neighbouring extension.
/// </summary>
public sealed class ConsoleRedisConnectionOptionsTests
{
    [Fact]
    public void NoAbortConnectFlagInTheConnectionString_IsForcedToNonAborting()
    {
        // ConfigurationOptions.Parse itself defaults AbortOnConnectFail to true when the connection
        // string is silent on it (confirmed directly against StackExchange.Redis 2.13.1) — so this
        // proves the wrapper's forcing behaviour, not the library's own default.
        var options = ConsoleRedisConnectionOptions.ParseForcingNonAborting("redis-host:6379,password=secret");

        Assert.False(options.AbortOnConnectFail);
    }

    [Fact]
    public void ExplicitAbortConnectTrue_IsOverriddenToFalse()
    {
        var options = ConsoleRedisConnectionOptions.ParseForcingNonAborting(
            "redis-host:6379,password=secret,abortConnect=true");

        Assert.False(options.AbortOnConnectFail);
    }

    [Fact]
    public void PreservesEverythingElseTheOperatorConfigured()
    {
        var options = ConsoleRedisConnectionOptions.ParseForcingNonAborting(
            "redis-host:6379,user=svc-account,password=hunter2,ssl=true,connectTimeout=5000,abortConnect=true");

        Assert.Contains(options.EndPoints, ep => ep.ToString()!.Contains("redis-host", StringComparison.Ordinal));
        Assert.Equal("svc-account", options.User);
        Assert.True(options.Ssl);
        Assert.Equal(5000, options.ConnectTimeout);
    }

    [Fact]
    public void DoesNotRedactThePassword()
    {
        // This function feeds a real connection, not a log — unlike RedisEndpointRedactor, it must
        // keep the password intact.
        const string password = "hunter2";
        var options = ConsoleRedisConnectionOptions.ParseForcingNonAborting(
            $"redis-host:6379,password={password}");

        Assert.Equal(password, options.Password);
    }
}
