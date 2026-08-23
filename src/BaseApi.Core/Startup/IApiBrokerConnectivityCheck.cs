using Messaging.Transport;

namespace BaseApi.Core.Startup;

/// <summary>
/// "The broker connection this process actually uses is open, with its topology declared" as
/// something a caller can await.
/// <para>
/// <b>Why it is an interface over a one-line implementation.</b> <see cref="RabbitMqConnection"/> is
/// sealed and <see cref="RabbitMqConnection.GetAsync"/> is not virtual, so a test holding a real one
/// can only ever exercise the broker-is-down branch — there is no way to stand up a connection that
/// succeeds without a real broker. This seam is what lets the preflight's success path be asserted
/// at all.
/// </para>
/// </summary>
public interface IApiBrokerConnectivityCheck
{
    /// <summary>
    /// Returns once the shared connection is open and this process's topology is declared, throwing
    /// the broker client's own exception if it cannot be. Idempotent and cheap after the first
    /// successful call anywhere in the process.
    /// </summary>
    Task CheckAsync(CancellationToken ct);
}

/// <summary>
/// The production <see cref="IApiBrokerConnectivityCheck"/>: it calls
/// <see cref="RabbitMqConnection.GetAsync"/> on the process's own shared connection and nothing else,
/// so a green result means the same connection every sender and consumer will use is open — not a
/// second connection the preflight opened and threw away.
/// </summary>
public sealed class ApiBrokerConnectivityCheck(RabbitMqConnection connection) : IApiBrokerConnectivityCheck
{
    private readonly RabbitMqConnection _connection =
        connection ?? throw new ArgumentNullException(nameof(connection));

    /// <inheritdoc/>
    public async Task CheckAsync(CancellationToken ct) =>
        await _connection.GetAsync(ct).ConfigureAwait(false);
}
