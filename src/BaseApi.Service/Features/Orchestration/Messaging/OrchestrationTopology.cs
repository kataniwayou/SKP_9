using Messaging.Contracts;
using Messaging.Transport;
using RabbitMQ.Client;

namespace BaseApi.Service.Features.Orchestration.Messaging;

/// <summary>
/// Declares the control queue, its dead-letter exchange, and the queue that parks refused messages.
/// <para>
/// <b>The declaration order is load-bearing.</b> The dead-letter exchange is declared first, because
/// a queue's dead-letter argument is not validated when the queue is declared: naming an exchange
/// that does not exist is accepted, and every message that queue later parks is discarded silently.
/// The failure has no error and no trace — it simply makes "a parked message can be recovered" false.
/// </para>
/// <para>
/// <b>The control queue carries no delivery limit, deliberately.</b> A limit counts every redelivery,
/// and this consumer redelivers on purpose whenever the projection store is unreachable — so a long
/// outage would exhaust the limit and dead-letter a message that was never malformed. What a limit
/// normally protects against is a message that fails forever, and that is already handled: the
/// consumer parks an unprocessable message on its first delivery rather than retrying it at all.
/// </para>
/// <para>
/// <b>Changing any argument below is a migration, not an edit.</b> Redeclaring an existing queue with
/// different arguments fails the channel with a precondition error, which here means the connection
/// cannot finish opening — so the service will not start until the old queue is drained and removed.
/// </para>
/// </summary>
internal sealed class OrchestrationTopology : IRabbitMqTopology
{
    public async Task DeclareAsync(IChannel channel, CancellationToken ct)
    {
        // 1. The dead-letter exchange, before anything names it.
        await channel.ExchangeDeclareAsync(
            exchange: OrchestratorQueues.DeadLetterExchange,
            type: ExchangeType.Direct,
            durable: true,
            autoDelete: false,
            arguments: null,
            cancellationToken: ct).ConfigureAwait(false);

        // 2. Where refused messages land, bound under the control queue's own name so a future second
        //    parked queue can share the exchange without ambiguity.
        await channel.QueueDeclareAsync(
            queue: OrchestratorQueues.ControlDead,
            durable: true,
            exclusive: false,
            autoDelete: false,
            arguments: new Dictionary<string, object?>
            {
                ["x-queue-type"] = "quorum",
            },
            cancellationToken: ct).ConfigureAwait(false);

        await channel.QueueBindAsync(
            queue: OrchestratorQueues.ControlDead,
            exchange: OrchestratorQueues.DeadLetterExchange,
            routingKey: OrchestratorQueues.Control,
            arguments: null,
            cancellationToken: ct).ConfigureAwait(false);

        // 3. The control queue itself. Durable so it survives a broker restart; a durable queue is
        //    half of the guarantee, with persistent delivery mode on each message being the other.
        await channel.QueueDeclareAsync(
            queue: OrchestratorQueues.Control,
            durable: true,
            exclusive: false,
            autoDelete: false,
            arguments: new Dictionary<string, object?>
            {
                ["x-queue-type"] = "quorum",
                ["x-dead-letter-exchange"] = OrchestratorQueues.DeadLetterExchange,
                ["x-dead-letter-routing-key"] = OrchestratorQueues.Control,
            },
            cancellationToken: ct).ConfigureAwait(false);
    }
}
