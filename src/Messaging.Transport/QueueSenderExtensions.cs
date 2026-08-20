namespace Messaging.Transport;

/// <summary>
/// Sending from inside a message handler, where a failure has to be classified rather than raised.
/// </summary>
public static class QueueSenderExtensions
{
    /// <summary>
    /// Sends, converting a recognised transport failure into a <see cref="TransientSendException"/> so
    /// the consumer returns the message to its queue instead of parking it. Every other failure
    /// propagates unchanged.
    /// <para>
    /// <b>Only recognised transport faults are wrapped, and the direction of that choice is
    /// deliberate.</b> <see cref="IQueueSender.SendAsync{T}"/> serializes the body inside the call and
    /// validates its arguments before that, so a contract that cannot be serialized throws straight
    /// through here. Wrapping it would tell the consumer to requeue a message that can never
    /// succeed — an infinite redelivery loop. An allow-list fails the other way: an unrecognised
    /// transport fault is parked, which is visible and recoverable by hand.
    /// </para>
    /// </summary>
    public static async Task SendTransientAsync<T>(
        this IQueueSender sender, string queue, string type, T body, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(sender);

        try
        {
            await sender.SendAsync(queue, type, body, ct).ConfigureAwait(false);
        }
        catch (TransientSendException)
        {
            // Already classified by a nested send. Re-wrapping would bury the real cause one level
            // deeper for no gain, and the consumer's classifier only reads the outermost type.
            throw;
        }
        catch (Exception ex) when (SendFaultClassifier.IsTransport(ex))
        {
            throw new TransientSendException($"send to {queue} failed", ex);
        }
    }
}
