using Messaging.Transport;

namespace BaseConsole.Core.Startup;

/// <summary>
/// "The broker connection this process actually uses is open, with its topology declared" as
/// something a caller can await.
/// <para>
/// <b>Why it is an interface over a one-line implementation.</b> <see cref="RabbitMqConnection"/> is
/// sealed and <see cref="RabbitMqConnection.GetAsync"/> is not virtual, so a test holding one can only
/// ever exercise the broker-is-down branch — there is no way to stand up a connection that succeeds
/// without a real broker. <c>Orchestrator.Messaging.ITopologyDeclarer</c> exists for the identical
/// reason; this is that same seam, one layer down, for the component that only ever needs to know
/// whether opening the connection succeeded.
/// </para>
/// <para>
/// <b>Public deliberately, not for outside consumers.</b> <c>BaseConsole.Core.csproj</c> grants
/// <c>InternalsVisibleTo</c> only to <c>BaseApi.Tests</c>, not to NSubstitute's dynamic proxy assembly
/// — the same reason <c>ITopologyDeclarer</c> is public rather than internal. Making this
/// <c>internal</c> instead would need a second <c>InternalsVisibleTo</c> grant naming
/// <c>DynamicProxyGenAssembly2</c>, widening exactly the same kind of surface a step further for no
/// gain: nothing outside this assembly constructs or calls it today, and nothing is meant to.
/// </para>
/// </summary>
public interface IRabbitMqConnectivityCheck
{
    /// <summary>
    /// Returns once the shared connection is open and this process's topology is declared, throwing
    /// the broker client's own exception if it cannot be. Idempotent and cheap after the first
    /// successful call anywhere in the process: <see cref="RabbitMqConnection"/> opens its connection
    /// once and every later caller — this one included — takes the fast path.
    /// </summary>
    Task CheckAsync(CancellationToken ct);
}

/// <summary>
/// The production <see cref="IRabbitMqConnectivityCheck"/>: it calls
/// <see cref="RabbitMqConnection.GetAsync"/> on the process's own shared connection and nothing else,
/// so a green result here means the same connection every sender and consumer will use is open — not
/// a connection preflight opened and threw away.
/// </summary>
public sealed class RabbitMqConnectivityCheck(RabbitMqConnection connection) : IRabbitMqConnectivityCheck
{
    private readonly RabbitMqConnection _connection =
        connection ?? throw new ArgumentNullException(nameof(connection));

    /// <inheritdoc/>
    public async Task CheckAsync(CancellationToken ct) =>
        await _connection.GetAsync(ct).ConfigureAwait(false);
}
