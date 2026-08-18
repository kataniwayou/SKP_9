namespace BaseApi.Core.Messaging;

/// <summary>
/// Broker connection settings, bound from the <c>RabbitMq</c> configuration section.
/// <para>
/// Credentials are bound rather than defaulted: a missing key is reported by name through the
/// fail-fast configuration helper, never silently replaced by <c>guest</c>, which would connect
/// successfully on a developer machine and fail only in the environment that matters.
/// </para>
/// </summary>
public sealed class RabbitMqOptions
{
    /// <summary>Broker host name.</summary>
    public string Host { get; set; } = "";

    /// <summary>Broker port. 5672 is the AMQP default and the only value most deployments use.</summary>
    public ushort Port { get; set; } = 5672;

    /// <summary>Virtual host. The root vhost unless a deployment separates tenants.</summary>
    public string VirtualHost { get; set; } = "/";

    /// <summary>Connecting user.</summary>
    public string Username { get; set; } = "";

    /// <summary>Connecting user's password.</summary>
    public string Password { get; set; } = "";

    /// <summary>
    /// Heartbeat interval. The broker drops a connection that misses two consecutive heartbeats, so
    /// this also bounds how long a half-open socket can masquerade as a live connection.
    /// </summary>
    public TimeSpan Heartbeat { get; set; } = TimeSpan.FromSeconds(30);
}
