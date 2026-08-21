using BaseApi.Core.DependencyInjection;
using Xunit;

namespace BaseApi.Tests.DependencyInjection;

/// <summary>
/// <see cref="ApiRedisConnectionOptions"/> is the whole non-aborting-connect contract for
/// <c>AddBaseApiRedis</c>, tested directly. The wiring itself cannot be exercised through a built
/// <see cref="Microsoft.Extensions.DependencyInjection.ServiceProvider"/> — resolving
/// <see cref="Microsoft.Extensions.DependencyInjection.ServiceCollectionServiceExtensions"/>'s
/// registered <c>IConnectionMultiplexer</c> singleton would run the real
/// <c>ConnectionMultiplexer.Connect</c> factory against a real socket.
/// </summary>
public sealed class ApiRedisConnectionOptionsTests
{
    [Fact]
    public void NoAbortConnectFlagInTheConnectionString_IsForcedToNonAborting()
    {
        // ConfigurationOptions.Parse itself defaults AbortOnConnectFail to true when the connection
        // string is silent on it (confirmed directly against StackExchange.Redis 2.13.1, the version
        // pinned in Directory.Packages.props) — so this proves the wrapper's forcing behaviour, not
        // the library's own default.
        var options = ApiRedisConnectionOptions.ParseForcingNonAborting("redis-host:6379,password=secret");

        Assert.False(options.AbortOnConnectFail);
    }

    [Fact]
    public void ExplicitAbortConnectTrue_IsOverriddenToFalse()
    {
        var options = ApiRedisConnectionOptions.ParseForcingNonAborting(
            "redis-host:6379,password=secret,abortConnect=true");

        Assert.False(options.AbortOnConnectFail);
    }

    [Fact]
    public void PreservesEverythingElseTheOperatorConfigured()
    {
        var options = ApiRedisConnectionOptions.ParseForcingNonAborting(
            "redis-host:6379,user=svc-account,password=hunter2,ssl=true,connectTimeout=5000,abortConnect=true");

        Assert.Contains(options.EndPoints, ep => ep.ToString()!.Contains("redis-host", StringComparison.Ordinal));
        Assert.Equal("svc-account", options.User);
        Assert.True(options.Ssl);
        Assert.Equal(5000, options.ConnectTimeout);
    }

    [Fact]
    public void DoesNotRedactThePassword()
    {
        // This function feeds a real connection, not a log — the password must survive intact.
        const string password = "hunter2";
        var options = ApiRedisConnectionOptions.ParseForcingNonAborting(
            $"redis-host:6379,password={password}");

        Assert.Equal(password, options.Password);
    }
}
