using StackExchange.Redis;

namespace BaseApi.Core.DependencyInjection;

/// <summary>
/// Parses a Redis connection string and forces <see cref="ConfigurationOptions.AbortOnConnectFail"/>
/// to <c>false</c>, deliberately overriding whatever the connection string itself says.
/// <para>
/// <b>Why this is forced rather than left to configuration.</b> <c>AddBaseApiRedis</c> is the one
/// place that materialises the process's <see cref="IConnectionMultiplexer"/>, and the API's
/// readiness design (<c>ApiRedisReadyHealthCheck</c>, wrapped by <c>ApiLatchedReadinessHealthCheck</c>)
/// is built on the assumption that Redis being down makes the process not-ready, never dead — the
/// health check resolves the multiplexer at check time and treats an unresolved one as unhealthy, not
/// fatal. <see cref="ConfigurationOptions.Parse(string)"/> alone defaults <c>AbortOnConnectFail</c> to
/// <c>true</c> (confirmed directly against StackExchange.Redis 2.13.1, the version pinned in
/// <c>Directory.Packages.props</c>) when the connection string is silent on it, and a connection string
/// carrying an explicit <c>abortConnect=true</c> asks for the same aborting behaviour. Either way the
/// throw would happen inside a DI factory — reachable during host startup, since
/// <c>AddBaseApiL2Gate</c> registers <c>L2GateProbe</c> as a hosted service that takes
/// <see cref="IConnectionMultiplexer"/> in its constructor — which turns a not-ready condition into a
/// dead or perpetually-throwing one instead of the degraded-but-alive state the health check contract
/// promises. Forcing the flag here, rather than trusting deployment manifests to set it, is what makes
/// that guarantee true in code instead of by convention.
/// </para>
/// <para>
/// Everything else the operator configured — endpoints, user, password, ssl, connect timeout, and so
/// on — passes through unchanged; only <c>AbortOnConnectFail</c> is touched.
/// </para>
/// <para>
/// This function feeds a real connection, not a log: unlike a redaction helper, it must not touch the
/// password, and nothing here logs or otherwise prints the parsed options or the connection string.
/// </para>
/// </summary>
internal static class ApiRedisConnectionOptions
{
    internal static ConfigurationOptions ParseForcingNonAborting(string connectionString)
    {
        var options = ConfigurationOptions.Parse(connectionString);
        options.AbortOnConnectFail = false;
        return options;
    }
}
