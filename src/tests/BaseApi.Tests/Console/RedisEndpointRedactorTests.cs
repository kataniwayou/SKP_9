using BaseConsole.Core.Startup;
using Xunit;

namespace BaseApi.Tests.Console;

/// <summary>
/// <see cref="RedisEndpointRedactor"/> is the one piece of production code that ever sees the raw
/// Redis connection string on the preflight's path — <c>StartupPreflightService</c> itself is
/// constructed from this method's output and never the raw string, so this is the whole redaction
/// contract, tested directly rather than through the service's logging.
/// </summary>
public sealed class RedisEndpointRedactorTests
{
    [Fact]
    public void RedactsThePasswordButKeepsTheHostAndPort()
    {
        const string password = "Tr0ub4dor&3Zebra";
        var connectionString = $"redis-host:6379,password={password},abortConnect=false";

        // The fixture is only meaningful if the raw string really does carry the secret.
        Assert.Contains(password, connectionString, StringComparison.Ordinal);

        var redacted = RedisEndpointRedactor.Redact(connectionString);

        Assert.DoesNotContain(password, redacted, StringComparison.Ordinal);
        Assert.Contains("redis-host", redacted, StringComparison.Ordinal);
        Assert.Contains("6379", redacted, StringComparison.Ordinal);
    }

    [Fact]
    public void KeepsTheUsernameWhichIsNotASecret()
    {
        var connectionString = "redis-host:6379,user=svc-account,password=hunter2,abortConnect=false";

        var redacted = RedisEndpointRedactor.Redact(connectionString);

        Assert.Contains("svc-account", redacted, StringComparison.Ordinal);
        Assert.DoesNotContain("hunter2", redacted, StringComparison.Ordinal);
    }
}
