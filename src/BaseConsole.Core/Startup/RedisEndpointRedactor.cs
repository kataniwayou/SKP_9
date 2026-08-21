using StackExchange.Redis;

namespace BaseConsole.Core.Startup;

/// <summary>
/// Turns a Redis connection string into the one form of it that is safe to put in a log: everything an
/// operator needs to tell host, port and vhost-equivalent settings apart — and nothing a password.
/// <para>
/// <b>The trap this exists to avoid.</b> <see cref="IConnectionMultiplexer.Configuration"/> looks like
/// the obvious safe source for "what did we connect to", but it returns the connection string
/// verbatim, password included — it is not safe to log. This method is the only thing in the preflight
/// path that ever touches the raw connection string; <c>StartupPreflightService</c> itself is
/// constructed from this method's output and never sees the original.
/// </para>
/// <para>
/// <b>What redacts it.</b> <see cref="ConfigurationOptions.ToString(bool)"/> — confirmed against
/// StackExchange.Redis 2.13.1 directly: <c>ToString()</c> (and <c>ToString(true)</c>) both include the
/// password verbatim, while <c>ToString(false)</c> replaces it with a fixed mask and keeps every other
/// setting, including the username, which is not a secret and is useful for telling "wrong password"
/// apart from "wrong account" on a failure.
/// </para>
/// </summary>
internal static class RedisEndpointRedactor
{
    public static string Redact(string connectionString)
        => ConfigurationOptions.Parse(connectionString).ToString(includePassword: false);
}
