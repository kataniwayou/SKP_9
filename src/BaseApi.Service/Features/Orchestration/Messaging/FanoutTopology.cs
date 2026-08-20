using Messaging.Contracts;
using Messaging.Transport;
using RabbitMQ.Client;

namespace BaseApi.Service.Features.Orchestration.Messaging;

/// <summary>
/// Declares the orchestrator fan-out exchange and its dead-letter exchange. Nothing else: the queues
/// each replica binds to are that replica's own responsibility, declared on its own connection setup.
/// <para>
/// <b>Declaring no queues here is deliberate, not an oversight.</b> A queue this file declared would
/// have to name a replica count the API does not own — the orchestrator is a StatefulSet whose replica
/// count is a deployment concern, and baking it into the API's source would make a scale-out or
/// scale-down a code change in the wrong service. Each replica declares its own
/// <see cref="OrchestratorFanout.PerReplica"/> queue and binds it to <see cref="OrchestratorFanout.Exchange"/>
/// on its own startup; this topology only has to make sure that exchange already exists when it does.
/// </para>
/// <para>
/// <b>The dead-letter exchange is declared here even though this service never parks anything to
/// it.</b> It is what each replica's own queue names in its <c>x-dead-letter-exchange</c> argument,
/// and that argument is not validated when the queue is declared — naming an exchange that does not
/// exist yet is accepted, and every message the queue later parks is discarded silently, with no error
/// and no trace anywhere. The API's connection setup runs before any replica can start, so declaring
/// the exchange here — rather than trusting a replica to declare it first — is what guarantees it
/// exists by the time a replica's queue names it.
/// </para>
/// <para>
/// <b>Changing either exchange's type or durability below is a migration, not an edit.</b>
/// Redeclaring an existing exchange with different arguments fails the channel with a precondition
/// error, which here means the connection cannot finish opening.
/// </para>
/// </summary>
internal sealed class FanoutTopology : IRabbitMqTopology
{
    public async Task DeclareAsync(IChannel channel, CancellationToken ct)
    {
        // The fan-out exchange every replica queue binds to. Durable, not auto-delete: an announcement
        // published while every replica happens to be down must still be there once one reconnects
        // and declares its queue.
        await channel.ExchangeDeclareAsync(
            exchange: OrchestratorFanout.Exchange,
            type: ExchangeType.Fanout,
            durable: true,
            autoDelete: false,
            arguments: null,
            cancellationToken: ct).ConfigureAwait(false);

        // The dead-letter exchange each replica's own queue names. See the type doc for why this must
        // exist before any replica queue can safely reference it.
        await channel.ExchangeDeclareAsync(
            exchange: OrchestratorFanout.DeadLetterExchange,
            type: ExchangeType.Direct,
            durable: true,
            autoDelete: false,
            arguments: null,
            cancellationToken: ct).ConfigureAwait(false);
    }
}
