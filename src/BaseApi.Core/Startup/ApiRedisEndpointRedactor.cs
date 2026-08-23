using StackExchange.Redis;

namespace BaseApi.Core.Startup;

/// <summary>
/// Turns a Redis connection string into the one form of it that is safe to put in a log: everything
/// an operator needs to tell one endpoint from another — and nothing a password.
/// <para>
/// <b>The trap this exists to avoid.</b> <see cref="IConnectionMultiplexer.Configuration"/> looks
/// like the obvious source for "what did we connect to", but it returns the connection string
/// verbatim, password included. <see cref="ConfigurationOptions.ToString(bool)"/> with
/// <c>includePassword: false</c> replaces the password with a fixed mask and keeps every other
/// setting — including the username, which is not a secret and is what tells "wrong password" apart
/// from "wrong account".
/// </para>
/// <para>
/// <b>A near-twin of <c>BaseConsole.Core.Startup.RedisEndpointRedactor</c>, and deliberately not
/// shared with it.</b> This assembly does not reference the console base library — the same firewall
/// that already gives <c>ApiRedisConnectionOptions</c> and <c>ApiRedisReadyHealthCheck</c> their own
/// copies of a console-side idea. Two lines of duplication is the cheaper side of that trade.
/// </para>
/// </summary>
internal static class ApiRedisEndpointRedactor
{
    public static string Redact(string connectionString)
        => ConfigurationOptions.Parse(connectionString).ToString(includePassword: false);
}
