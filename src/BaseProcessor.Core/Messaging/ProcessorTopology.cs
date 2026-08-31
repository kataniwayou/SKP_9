using Messaging.Contracts;
using Messaging.Transport;
using RabbitMQ.Client;

namespace BaseProcessor.Core.Messaging;

/// <summary>
/// Declares this processor's two queues — the work queue it is dispatched on and the post queue its
/// author hands branches to — their shared dead-letter exchange, and where each parks what it refuses.
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
/// <para>
/// <b>Two queues, mirroring the orchestrator's own advance/materialise pair.</b> See
/// <see cref="ProcessorQueues.Post"/> for why the branch hop is a queue rather than a second type on
/// the work queue. Both pairs are declared by <see cref="DeadLetteredPair"/>, which every topology in
/// this system now shares — dead queue and binding first, then the live queue naming it, with one
/// routing key feeding both halves so they cannot drift.
/// </para>
/// </summary>
internal sealed class ProcessorTopology(Guid processorId) : IRabbitMqTopology
{
    public async Task DeclareAsync(IChannel channel, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(channel);

        // First, and not negotiably: the dead-letter argument below is not validated when the queue is
        // declared, so naming an exchange that does not exist is accepted and every parked message is
        // discarded silently. One exchange serves both pairs; the dead queues differ by routing key.
        await channel.ExchangeDeclareAsync(
            exchange: ProcessorQueues.DeadLetterExchange,
            type: ExchangeType.Direct,
            durable: true,
            autoDelete: false,
            arguments: null,
            cancellationToken: ct).ConfigureAwait(false);

        // The routing key is the LIVE queue's own name on both pairs — this assembly's convention.
        // DeadLetteredPair takes it once and feeds both the binding and the queue's
        // x-dead-letter-routing-key, so the two cannot drift apart into a silent discard.
        await DeadLetteredPair.DeclareAsync(
            channel, ProcessorQueues.Work(processorId), ProcessorQueues.Dead(processorId),
            ProcessorQueues.DeadLetterExchange, ProcessorQueues.Work(processorId), ct)
            .ConfigureAwait(false);

        await DeadLetteredPair.DeclareAsync(
            channel, ProcessorQueues.Post(processorId), ProcessorQueues.PostDead(processorId),
            ProcessorQueues.DeadLetterExchange, ProcessorQueues.Post(processorId), ct)
            .ConfigureAwait(false);
    }
}
