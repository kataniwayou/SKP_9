using RabbitMQ.Client;

namespace Messaging.Transport;

/// <summary>
/// Declares one live queue together with the queue its refusals park in, as a single unit.
/// <para>
/// <b>The point is that ONE routing key feeds both halves.</b> A dead-lettered message is
/// republished to the dead-letter exchange under the live queue's
/// <c>x-dead-letter-routing-key</c>, and every dead-letter exchange in this system is
/// <c>direct</c> — so the parked message arrives only if the dead queue is bound under a key
/// that matches EXACTLY. Those are two separately-declared values, and when they disagree the
/// broker discards every parked message with no error, no log and nothing on any board. Taking
/// the key once, as a parameter, is what makes that disagreement unrepresentable rather than
/// merely unlikely.
/// </para>
/// <para>
/// <b>The order is not negotiable either.</b> The dead queue and its binding are declared before
/// the live queue that names the exchange, because <c>x-dead-letter-exchange</c> is not validated
/// at declare time: a queue pointing at an exchange that does not exist yet is accepted, and
/// everything it later parks is silently gone.
/// </para>
/// <para>
/// <b>The exchange itself is the caller's job.</b> Three topologies share four dead-letter
/// exchanges between them, and each declares its own before calling in here — hoisting it would
/// re-declare the same exchange once per pair for no gain.
/// </para>
/// <para>
/// <b><c>x-delivery-limit</c> is -1 on both queues, meaning unlimited, and is stated rather than
/// omitted.</b> RabbitMQ 4.x applies a default limit of 20 to any quorum queue that declares
/// none, so an omission means twenty with nothing in the source saying so — and every consumer
/// here requeues on purpose for as long as the projection store is unreachable, which would
/// exhaust twenty cycles inside an outage this design is built to ride out.
/// </para>
/// </summary>
public static class DeadLetteredPair
{
    /// <param name="channel">The setup channel; owned by the caller.</param>
    /// <param name="queue">The live queue.</param>
    /// <param name="dead">The queue <paramref name="queue"/> parks refusals in.</param>
    /// <param name="deadLetterExchange">
    /// The direct exchange the pair rendezvous on. Must already be declared.
    /// </param>
    /// <param name="routingKey">
    /// The rendezvous token, used for BOTH the dead queue's binding and the live queue's
    /// <c>x-dead-letter-routing-key</c>. Its value is arbitrary so long as both sides agree, which
    /// taking it once here guarantees.
    /// <para>
    /// Two values are in use across this system: the live queue's own name, and the dead queue's.
    /// Both route correctly; they differ in what the key MEANS at the exchange — origin versus
    /// destination — and the split is why this is a parameter today rather than
    /// <c>queue</c> hard-coded. See <c>DeadLetterConventionTests</c>, which pins the split and
    /// names what has to change to close it.
    /// </para>
    /// </param>
    /// <param name="ct">Cancellation for the declares.</param>
    public static async Task DeclareAsync(
        IChannel channel, string queue, string dead, string deadLetterExchange,
        string routingKey, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(channel);
        ArgumentException.ThrowIfNullOrWhiteSpace(queue);
        ArgumentException.ThrowIfNullOrWhiteSpace(dead);
        ArgumentException.ThrowIfNullOrWhiteSpace(deadLetterExchange);
        ArgumentException.ThrowIfNullOrWhiteSpace(routingKey);

        await channel.QueueDeclareAsync(
            queue: dead,
            durable: true,
            exclusive: false,
            autoDelete: false,
            arguments: new Dictionary<string, object?>
            {
                ["x-queue-type"] = "quorum",
                ["x-delivery-limit"] = -1,
            },
            cancellationToken: ct).ConfigureAwait(false);

        await channel.QueueBindAsync(
            queue: dead,
            exchange: deadLetterExchange,
            routingKey: routingKey,
            arguments: null,
            cancellationToken: ct).ConfigureAwait(false);

        await channel.QueueDeclareAsync(
            queue: queue,
            durable: true,
            exclusive: false,
            autoDelete: false,
            arguments: new Dictionary<string, object?>
            {
                ["x-queue-type"] = "quorum",
                ["x-dead-letter-exchange"] = deadLetterExchange,
                ["x-dead-letter-routing-key"] = routingKey,
                ["x-delivery-limit"] = -1,
            },
            cancellationToken: ct).ConfigureAwait(false);
    }
}
