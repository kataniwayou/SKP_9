using Messaging.Transport;

namespace Orchestrator.Messaging;

/// <summary>
/// "This replica's fan-out queue exists on the broker" as something a caller can await.
/// <para>
/// <b>Why hydration needs this at all.</b> Declaring topology is a side effect of opening the shared
/// broker connection (<see cref="RabbitMqConnection.GetAsync"/>), and the only thing in this process
/// that opened it at boot was the gated consumer — which is registered after the hydration loop and
/// therefore ran after it. A hosted service's <c>StartAsync</c> returns at its first await, so
/// hydration had already issued its <c>SMEMBERS</c> against L2 before the queue this replica listens
/// on existed. An announcement published in that window routed to the replicas whose queues did
/// exist, satisfied <c>mandatory</c>, and was lost to this one permanently: not in its L1, and no
/// anti-entropy pass to find it. Durable queues make that reachable only on the first-ever start of
/// a replica ordinal — a first deploy, or a scale-up onto a live system.
/// </para>
/// <para>
/// <b>Why it is an interface over a one-line implementation.</b> <see cref="RabbitMqConnection"/> is
/// sealed and <see cref="RabbitMqConnection.GetAsync"/> is not virtual, so a test holding one can
/// only ever exercise the broker-is-down branch — there is no way to stand up a connection that
/// succeeds without a broker. This seam is what lets the hydration tests assert the ordering itself,
/// which is the property that was wrong, rather than only the failure that follows from it.
/// </para>
/// </summary>
public interface ITopologyDeclarer
{
    /// <summary>
    /// Returns once this replica's topology is declared, throwing if the broker cannot be reached.
    /// Idempotent and cheap after the first call: the connection is opened once per process and every
    /// later call takes the fast path.
    /// </summary>
    ValueTask EnsureDeclaredAsync(CancellationToken ct);
}

/// <summary>
/// The production <see cref="ITopologyDeclarer"/>: it opens the shared connection, which is what runs
/// every registered <see cref="IRabbitMqTopology"/> — <see cref="OrchestratorTopology"/> among them.
/// It deliberately does nothing else, so that "the topology exists" stays a property of holding a
/// connection rather than a second declaration path that could drift from the first.
/// </summary>
public sealed class ConnectionTopologyDeclarer(RabbitMqConnection connection) : ITopologyDeclarer
{
    private readonly RabbitMqConnection _connection =
        connection ?? throw new ArgumentNullException(nameof(connection));

    /// <inheritdoc/>
    public async ValueTask EnsureDeclaredAsync(CancellationToken ct) =>
        await _connection.GetAsync(ct).ConfigureAwait(false);
}
