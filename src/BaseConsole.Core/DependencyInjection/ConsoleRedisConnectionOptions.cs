using StackExchange.Redis;

namespace BaseConsole.Core.DependencyInjection;

/// <summary>
/// Parses a Redis connection string and forces <see cref="ConfigurationOptions.AbortOnConnectFail"/>
/// to <c>false</c>, deliberately overriding whatever the connection string itself says.
/// <para>
/// <b>Why this is forced rather than left to configuration.</b> <c>AddBaseConsoleRedis</c> is the one
/// place that materialises the process's <see cref="IConnectionMultiplexer"/>, and the console stack's
/// gate-and-probe design (<c>L2Gate</c>, <c>L2GateProbe</c>, <c>StartupPreflightService</c>) is built on
/// the assumption that the multiplexer always exists and may simply be disconnected — never that
/// resolving it can throw. <see cref="ConfigurationOptions.Parse(string)"/> alone defaults
/// <c>AbortOnConnectFail</c> to <c>true</c> (confirmed directly against StackExchange.Redis 2.13.1) when
/// the connection string is silent on it, and a connection string carrying an explicit
/// <c>abortConnect=true</c> would ask for the same aborting behaviour. Either way the throw would
/// happen inside a DI factory during <c>Host.StartAsync</c>'s hosted-service enumeration, killing the
/// host before any diagnostic — including <c>StartupPreflightService</c>, which exists specifically to
/// report a dead Redis — ever runs. Forcing the flag here, rather than trusting the manifests to set
/// it, is what makes that guarantee true in code instead of by convention across three separate
/// deployment files that would otherwise each have to remember it independently.
/// </para>
/// <para>
/// Everything else the operator configured — endpoints, user, password, ssl, connect timeout, and so
/// on — passes through unchanged; only <c>AbortOnConnectFail</c> is touched.
/// </para>
/// <para>
/// Unlike <see cref="Startup.RedisEndpointRedactor"/>, this does not redact anything: its output feeds
/// a real connection, not a log, so the password must survive intact.
/// </para>
/// </summary>
internal static class ConsoleRedisConnectionOptions
{
    public static ConfigurationOptions ParseForcingNonAborting(string connectionString)
    {
        var options = ConfigurationOptions.Parse(connectionString);
        options.AbortOnConnectFail = false;
        return options;
    }
}
