namespace Processor.EmsExporter.Ems;

/// <summary>
/// The connection factory's connect and reconnect limits, derived from the step's delivery timeout.
/// Split out from the adapter because this is the half that can be asserted without a server.
/// <para>
/// <b>Why these exist at all:</b> an EMS send has no timeout of its own. With a fault-tolerant URL
/// list a send blocks for as long as the client is reconnecting, and the default reconnect settings
/// are TIBCO's, not the author's. Bounding the attempts makes the client give up — and the send
/// throw — inside the window the author chose, instead of holding the dispatch, and at a prefetch of
/// one the replica's only lane, while it retries. The processor's backstop covers the case these do
/// not: a server that accepted the connection and then stopped answering.
/// </para>
/// <para>
/// <b>The invariant:</b> <c>Attempts × (Delay + AttemptTimeout) ≤ deliveryTimeout</c>, for connect
/// and reconnect alike, so a client that exhausts its attempts has done so before the timeout.
/// </para>
/// </summary>
/// <remarks>
/// Milliseconds as <see cref="int"/> because that is what the EMS <c>ConnectionFactory</c> setters
/// (<c>SetConnAttemptTimeout</c> and the rest) take.
/// </remarks>
public sealed record EmsConnectionLimits(int Attempts, int DelayMs, int AttemptTimeoutMs)
{
    /// <summary>
    /// The floor <c>DeliveryTimeoutSeconds</c> is validated against. Below a second the per-attempt
    /// timeout would be shorter than a TLS handshake to a server across a network.
    /// </summary>
    public static readonly TimeSpan MinimumDeliveryTimeout = TimeSpan.FromSeconds(1);

    /// <summary>
    /// Three attempts: enough to ride out a fault-tolerant pair's failover, few enough that each
    /// still gets a useful slice of the window.
    /// </summary>
    private const int AttemptCount = 3;

    /// <summary>The pause between attempts is a tenth of the window, and never more than a second.</summary>
    private static readonly TimeSpan MaximumDelay = TimeSpan.FromSeconds(1);

    public static EmsConnectionLimits For(TimeSpan deliveryTimeout)
    {
        if (deliveryTimeout < MinimumDeliveryTimeout)
        {
            throw new ArgumentOutOfRangeException(
                nameof(deliveryTimeout), deliveryTimeout, $"must be at least {MinimumDeliveryTimeout}");
        }

        var total = (long)deliveryTimeout.TotalMilliseconds;
        var delay = Math.Min(total / 10, (long)MaximumDelay.TotalMilliseconds);
        var attemptTimeout = (total - (AttemptCount * delay)) / AttemptCount;

        // Clamped for the int setters; a window that large has stopped being a timeout anyway.
        return new EmsConnectionLimits(
            AttemptCount,
            (int)delay,
            (int)Math.Min(attemptTimeout, int.MaxValue));
    }
}
