using Messaging.Contracts;
using Messaging.Transport;
using RabbitMQ.Client;

namespace BaseProcessor.Core.Messaging;

/// <summary>
/// Declares this processor's work queue, its dead-letter exchange, and where refused messages land.
/// <para>
/// <b>Declared at connection setup rather than when consuming starts.</b> This consumer pauses
/// whenever the projection store is unreachable, and a paused consumer declares nothing — so a
/// dispatch arriving in that window would address a queue that does not exist, which the broker
/// discards while still confirming the send. The orchestrator would be told the work was accepted.
/// </para>
/// <para>
/// The processor id is known before the host exists, thanks to the two-stage boot, which is what
/// makes declaring here possible at all.
/// </para>
/// </summary>
internal sealed class ProcessorTopology(Guid processorId) : IRabbitMqTopology
{
    public async Task DeclareAsync(IChannel channel, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(channel);

        // First, and not negotiably: the dead-letter argument below is not validated when the queue is
        // declared, so naming an exchange that does not exist is accepted and every parked message is
        // discarded silently.
        await channel.ExchangeDeclareAsync(
            exchange: ProcessorQueues.DeadLetterExchange,
            type: ExchangeType.Direct,
            durable: true,
            autoDelete: false,
            arguments: null,
            cancellationToken: ct).ConfigureAwait(false);

        var work = ProcessorQueues.Work(processorId);
        var dead = ProcessorQueues.Dead(processorId);

        await channel.QueueDeclareAsync(
            queue: dead,
            durable: true,
            exclusive: false,
            autoDelete: false,
            arguments: new Dictionary<string, object?> { ["x-queue-type"] = "quorum" },
            cancellationToken: ct).ConfigureAwait(false);

        await channel.QueueBindAsync(
            queue: dead,
            exchange: ProcessorQueues.DeadLetterExchange,
            routingKey: work,
            arguments: null,
            cancellationToken: ct).ConfigureAwait(false);

        // No x-delivery-limit, deliberately: a limit counts every redelivery, and this consumer
        // redelivers on purpose for as long as the projection store is unreachable. What a limit
        // normally guards against is already handled — an unreadable message is parked on its first
        // delivery rather than retried at all.
        await channel.QueueDeclareAsync(
            queue: work,
            durable: true,
            exclusive: false,
            autoDelete: false,
            arguments: new Dictionary<string, object?>
            {
                ["x-queue-type"] = "quorum",
                ["x-dead-letter-exchange"] = ProcessorQueues.DeadLetterExchange,
                ["x-dead-letter-routing-key"] = work,
            },
            cancellationToken: ct).ConfigureAwait(false);
    }
}
