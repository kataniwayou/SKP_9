using RabbitMQ.Client;

namespace BaseApi.Core.Messaging;

/// <summary>
/// A unit of broker topology — the exchanges, queues and bindings one feature needs — declared
/// exactly once, during connection setup, before any send or consume runs.
/// <para>
/// <b>Declaration is deliberately not a side effect of consuming.</b> A consumer that declares its
/// own queue on start does not declare it while it is paused, and this service pauses its consumer
/// whenever the projection store is unreachable. A send arriving in that window would address a queue
/// that does not exist — and an unroutable message is discarded by the broker and still confirmed to
/// the sender, so the request would be answered as accepted and then lost, with no error anywhere.
/// Hanging declaration off connection setup instead makes "the queue exists" a precondition of
/// holding a connection at all, which both paths already require.
/// </para>
/// <para>
/// Implementations must be idempotent: the connection recovers automatically, and a redeclaration of
/// an identical queue is a no-op. A redeclaration with <i>different</i> arguments is not — it fails
/// the channel with a precondition error, which is why argument changes are a migration rather than
/// an edit.
/// </para>
/// </summary>
public interface IRabbitMqTopology
{
    /// <summary>
    /// Declare this feature's topology on the supplied setup channel. The channel is owned by the
    /// caller and closed once every implementation has run.
    /// </summary>
    Task DeclareAsync(IChannel channel, CancellationToken ct);
}
