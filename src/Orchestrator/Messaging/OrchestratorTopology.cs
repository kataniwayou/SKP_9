using BaseConsole.Core.Messaging;
using Messaging.Contracts;
using Messaging.Transport;
using RabbitMQ.Client;

namespace Orchestrator.Messaging;

/// <summary>
/// Declares this replica's queue on the orchestrator fan-out exchange, its dead-letter exchange, and
/// where refused announcements land.
/// <para>
/// <b>Declared at connection setup rather than when consuming starts.</b> Redeclaring the two
/// exchanges here is idempotent with the API side's own declaration of them — one broker-side
/// definition is shared by both — and the important property is not whether either side declares them
/// again but the order this replica declares its own queue against them.
/// </para>
/// <para>
/// <b>The dead-letter exchange must come before any queue naming it, and that is not negotiable.</b>
/// The <c>x-dead-letter-exchange</c> argument is not validated when a queue is declared, so naming an
/// exchange that does not yet exist is accepted without complaint — and every message the queue
/// subsequently parks there is discarded by the broker with no error anywhere. Declaring the
/// dead-letter exchange first is what keeps a parked announcement recoverable rather than silently
/// gone.
/// </para>
/// </summary>
internal sealed class OrchestratorTopology(InstanceId instanceId) : IRabbitMqTopology
{
    public async Task DeclareAsync(IChannel channel, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(channel);

        // First, and not negotiably: see the type remarks.
        await channel.ExchangeDeclareAsync(
            exchange: OrchestratorFanout.DeadLetterExchange,
            type: ExchangeType.Direct,
            durable: true,
            autoDelete: false,
            arguments: null,
            cancellationToken: ct).ConfigureAwait(false);

        await channel.ExchangeDeclareAsync(
            exchange: OrchestratorFanout.Exchange,
            type: ExchangeType.Fanout,
            durable: true,
            autoDelete: false,
            arguments: null,
            cancellationToken: ct).ConfigureAwait(false);

        var queue = OrchestratorFanout.PerReplica(instanceId.Value);
        var dead = OrchestratorFanout.Dead(instanceId.Value);

        // Durable and never auto-delete, matching OrchestratorFanout's own remarks: a replica that is
        // down must accumulate its announcements and drain them on return, and the cost of that is a
        // queue outliving a permanently-removed replica.
        // The routing key is the LIVE queue's name, matching the API's control pair and every
        // processor pair. It used to be the dead queue's name; the two conventions meant the key
        // could not be derived from a queue name, so a redrive tool that computed it was right on
        // some queues and, on the others, published under a key nothing was bound to — which a
        // direct exchange discards. Keying on the source also makes the key carry provenance:
        // at the exchange it says which queue refused the message.
        await DeadLetteredPair.DeclareAsync(
            channel, queue, dead, OrchestratorFanout.DeadLetterExchange, queue, ct)
            .ConfigureAwait(false);

        // Empty routing key: the fan-out exchange is a fanout exchange, which ignores routing keys
        // entirely and delivers to every bound queue regardless.
        await channel.QueueBindAsync(
            queue: queue,
            exchange: OrchestratorFanout.Exchange,
            routingKey: string.Empty,
            arguments: null,
            cancellationToken: ct).ConfigureAwait(false);

        // The execution path. Unlike the announcement queue above, these two are SHARED: one name for
        // the whole deployment, every replica a competing consumer on it. Each replica declares them
        // identically, which is idempotent at the broker and is what lets a replica that starts first
        // serve them alone until the others arrive.
        await channel.ExchangeDeclareAsync(
            exchange: OrchestratorQueues.DeadLetterExchange,
            type: ExchangeType.Direct,
            durable: true,
            autoDelete: false,
            arguments: null,
            cancellationToken: ct).ConfigureAwait(false);

        await DeclareSharedAsync(channel, OrchestratorQueues.Result, OrchestratorQueues.ResultDead, ct)
            .ConfigureAwait(false);
        await DeclareSharedAsync(channel, OrchestratorQueues.ResultPost, OrchestratorQueues.ResultPostDead, ct)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// One shared execution queue and the queue it parks into. The declare order, the quorum type and
    /// the unlimited delivery limit all come from <see cref="DeadLetteredPair"/>, which documents each
    /// of them; this method exists only to bind the two arguments the shared declarer cannot infer
    /// — which exchange, and which routing key.
    /// <para>
    /// <b>The key is the LIVE queue's own name</b>, as it is everywhere else in this system. That is
    /// what makes the token derivable from a queue name alone, which is what a redrive tool needs,
    /// and what makes the key mean "refused BY this queue" rather than restating the binding.
    /// </para>
    /// </summary>
    private static Task DeclareSharedAsync(
        IChannel channel, string queue, string dead, CancellationToken ct)
        => DeadLetteredPair.DeclareAsync(
            channel, queue, dead, OrchestratorQueues.DeadLetterExchange, queue, ct);
}
