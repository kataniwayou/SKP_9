namespace Messaging.Transport;

/// <summary>
/// Publishes one message to a fan-out exchange, so that every queue bound to it receives a copy.
/// <para>
/// <b>Separate from <see cref="IQueueSender"/> on purpose.</b> That interface is send-not-publish by
/// its own contract — "addressed to a queue whose consumer is known, not offered to whoever is
/// interested" — and its implementation is documented as having no exchange in the middle to
/// misconfigure. Both statements stay true only if publishing lives somewhere else.
/// </para>
/// <para>
/// <b>An unroutable publish is a failure here, not a success.</b> Publisher confirms report that the
/// broker accepted a message, not that it routed one, so an exchange with no bound queue would confirm
/// a message it discarded. This interface publishes mandatory and raises
/// <see cref="UnroutablePublishException"/> instead, which classifies as transport so the caller
/// requeues rather than acknowledging work that vanished.
/// </para>
/// </summary>
public interface IQueueFanoutPublisher
{
    /// <param name="exchange">The fan-out exchange to publish to. Must already be declared.</param>
    /// <param name="type">Discriminator written to the type header.</param>
    /// <param name="body">Payload, serialized with the shared messaging serializer options.</param>
    /// <param name="ct">Cancels the publish.</param>
    Task PublishAsync<T>(string exchange, string type, T body, CancellationToken ct);
}

/// <summary>
/// A publish the broker accepted but could not route: the exchange had no bound queue. Recognised as
/// transport by <see cref="SendFaultClassifier"/>, because the condition is resolved by a consumer
/// declaring its queue — which is a matter of time, not of the message being wrong.
/// </summary>
public sealed class UnroutablePublishException(string exchange)
    : Exception($"nothing is bound to exchange '{exchange}', so the message was discarded");
