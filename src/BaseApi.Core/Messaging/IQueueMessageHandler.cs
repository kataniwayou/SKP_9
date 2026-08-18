namespace BaseApi.Core.Messaging;

/// <summary>
/// Handles one kind of message off a gated queue.
/// <para>
/// <b>What a handler throws decides the message's fate, so the contract is about exceptions.</b> A
/// failure that reflects the projection store being unreachable must reach the consumer as such —
/// wrapped is fine, swallowed is not — because that is what returns the message to the queue instead
/// of parking it. Anything else is taken as the message being unprocessable and parks it on the first
/// delivery, with no retry.
/// </para>
/// <para>
/// A handler is resolved per delivery from its own scope, so scoped dependencies are safe to inject
/// and nothing is shared between deliveries.
/// </para>
/// </summary>
public interface IQueueMessageHandler
{
    /// <summary>
    /// The type discriminator this handler claims, matched against the message's type header. Two
    /// handlers claiming the same value is a wiring error the consumer reports rather than resolving.
    /// </summary>
    string MessageType { get; }

    /// <summary>Process one message body. Returning normally acknowledges it.</summary>
    Task HandleAsync(ReadOnlyMemory<byte> body, CancellationToken ct);
}
