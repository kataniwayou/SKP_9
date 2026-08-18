namespace BaseApi.Core.Messaging;

/// <summary>
/// Sends one message to one named queue and does not return until the broker has accepted
/// responsibility for it.
/// <para>
/// <b>Send, not publish.</b> The distinction is about intent rather than API: these messages are
/// addressed to a queue whose consumer is known, not offered to whoever is interested. It is
/// implemented as a publish to the default exchange, which routes by queue name — so the routing key
/// is the queue name, and there is no exchange in the middle to misconfigure.
/// </para>
/// </summary>
public interface IQueueSender
{
    /// <summary>
    /// Serialize <paramref name="body"/>, stamp <paramref name="type"/> as the message's type header,
    /// and send it to <paramref name="queue"/> durably.
    /// <para>
    /// Returns only once the broker has confirmed the message. A failure to route it, a broker
    /// refusal, or a dead connection all surface as exceptions — the method never completes
    /// successfully for a message that was not stored.
    /// </para>
    /// </summary>
    /// <typeparam name="T">The message contract being sent.</typeparam>
    /// <param name="queue">Destination queue name, used directly as the routing key.</param>
    /// <param name="type">Discriminator written to the type header; see the shared message-type constants.</param>
    /// <param name="body">Payload, serialized with the shared messaging serializer options.</param>
    /// <param name="ct">Cancels the send. A cancelled send may or may not have reached the broker.</param>
    Task SendAsync<T>(string queue, string type, T body, CancellationToken ct);
}
