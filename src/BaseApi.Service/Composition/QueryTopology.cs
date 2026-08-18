using Messaging.Contracts;
using Messaging.Transport;
using RabbitMQ.Client;

namespace BaseApi.Service.Composition;

/// <summary>
/// Declares the two query queues this service answers on.
/// <para>
/// <b>Durable, with no dead-letter exchange, and that is not an omission.</b> A query has a caller
/// waiting on a reply address with a timeout; a request that cannot be answered is of no use to
/// anyone once that timeout has passed, so there is nothing worth parking. Durability is kept so a
/// broker restart does not silently remove the queues that callers address.
/// </para>
/// </summary>
internal sealed class QueryTopology : IRabbitMqTopology
{
    public async Task DeclareAsync(IChannel channel, CancellationToken ct)
    {
        foreach (var queue in new[] { ProcessorQueues.IdentityQuery, ProcessorQueues.SchemaQuery })
        {
            await channel.QueueDeclareAsync(
                queue: queue,
                durable: true,
                exclusive: false,
                autoDelete: false,
                arguments: null,
                cancellationToken: ct).ConfigureAwait(false);
        }
    }
}
