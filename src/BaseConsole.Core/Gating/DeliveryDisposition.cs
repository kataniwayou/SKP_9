namespace BaseConsole.Core.Gating;

/// <summary>What a consumer does with a delivery whose handling threw.</summary>
public enum DeliveryDisposition
{
    /// <summary>
    /// Reject without requeue. The message is unprocessable and no redelivery can change that, so it
    /// goes to the dead-letter queue where a human can recover it.
    /// </summary>
    Park,

    /// <summary>
    /// Return to the queue, leaving the projection-store gate open. Something other than the store
    /// failed — a broker send, typically — and consumption should continue.
    /// </summary>
    Requeue,

    /// <summary>
    /// Return to the queue and close the gate. The projection store is unreachable, so every message
    /// would fail the same way; pausing at the broker costs nothing while it recovers.
    /// </summary>
    RequeueAndTrip,
}
