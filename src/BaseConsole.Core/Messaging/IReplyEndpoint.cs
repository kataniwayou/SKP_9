namespace BaseConsole.Core.Messaging;

/// <summary>
/// This replica's own reply address, and the guarantee that it is currently bound.
/// <para>
/// The seam exists because an asker needs exactly two things from its reply queue — where to tell
/// the responder to write, and the assurance that someone is listening there before the ask goes out.
/// It does not need to know that the queue is exclusive, auto-delete, or re-declared after a broker
/// reconnect. Separating the two also means the asking loop can be exercised without a broker.
/// </para>
/// </summary>
public interface IReplyEndpoint
{
    /// <summary>The queue name to send as <c>ReplyTo</c> on every request.</summary>
    string QueueName { get; }

    /// <summary>
    /// Returns once the broker has confirmed the subscription, re-declaring it first if the previous
    /// channel died. Cheap and idempotent when it is already live, so a loop may call it every tick —
    /// which is what re-establishes the queue after a reconnect, since it dies with its connection.
    /// </summary>
    Task EnsureStartedAsync(CancellationToken ct);
}
