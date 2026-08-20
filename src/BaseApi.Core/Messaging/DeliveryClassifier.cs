using BaseApi.Core.Gating;
using Messaging.Transport;

namespace BaseApi.Core.Messaging;

/// <summary>
/// The single branch that decides a failed delivery's fate, extracted from the consumer so it can be
/// exercised without a broker.
/// <para>
/// <b>The order of the two transient tests is load-bearing.</b>
/// <see cref="L2FaultClassifier.IsTransient"/> walks the entire exception chain, so a send failure
/// that happens to wrap a Redis type would be read as a store outage and would close the gate —
/// pausing consumption over a store that never failed. Testing the send classification first makes
/// the outermost type the one that decides, which is the type that names what actually broke.
/// </para>
/// </summary>
public static class DeliveryClassifier
{
    public static DeliveryDisposition Classify(Exception ex)
    {
        ArgumentNullException.ThrowIfNull(ex);

        if (ex is TransientSendException)
        {
            return DeliveryDisposition.Requeue;
        }

        return L2FaultClassifier.IsTransient(ex)
            ? DeliveryDisposition.RequeueAndTrip
            : DeliveryDisposition.Park;
    }
}
