using System.Net.Sockets;

namespace Messaging.Transport;

/// <summary>
/// Whether a failure raised during a send is the transport failing, as opposed to the message being
/// unsendable.
/// <para>
/// <b>An allow-list, because the two mistakes are not equally bad.</b> Miss a transport fault and the
/// message is parked — visible in a dead-letter queue, recoverable by hand. Miss a deterministic
/// fault and the consumer requeues a message that will fail identically forever. The first is an
/// inconvenience; the second is an outage that never resolves.
/// </para>
/// <para>
/// The chain is walked because transport libraries wrap: a socket failure commonly arrives inside a
/// broker exception, and the outermost type alone would miss it.
/// </para>
/// <para>
/// <see cref="ObjectDisposedException"/> is on the list because a channel disposed underneath an
/// in-flight send during shutdown raises it, and it is neither one of the other members nor in the
/// broker client's namespace. That is the environment going away mid-send, not the message being
/// unsendable — and parking work because the process was stopping is a park no redelivery repairs.
/// </para>
/// </summary>
public static class SendFaultClassifier
{
    public static bool IsTransport(Exception ex)
    {
        ArgumentNullException.ThrowIfNull(ex);

        return Unwrap(ex).Any(IsTransportType);
    }

    private static bool IsTransportType(Exception e)
    {
        if (e is IOException or SocketException or TimeoutException or OperationCanceledException
                 or ObjectDisposedException)
        {
            return true;
        }

        // Matched by namespace rather than by a list of type names: the broker client's exception
        // set changes between major versions, and a name list silently stops matching the type it
        // was written for while still compiling.
        return e.GetType().Namespace?.StartsWith("RabbitMQ.Client", StringComparison.Ordinal) == true;
    }

    /// <summary>
    /// Flattens aggregates and walks inner exceptions, yielding every exception in the chain.
    /// <para>
    /// <b>Aggregates need flattening, not just walking.</b> <see cref="Exception.InnerException"/> on
    /// an aggregate is only its FIRST inner one, so a chain walk reaches a single branch and a socket
    /// failure sitting in position two is classified deterministic and parked — the expensive mistake
    /// this allow-list is shaped to avoid. The sibling classifier on the projection side,
    /// <c>L2FaultClassifier.Unwrap</c>, flattens for exactly this reason; this is the same shape.
    /// </para>
    /// </summary>
    private static IEnumerable<Exception> Unwrap(Exception ex)
    {
        if (ex is AggregateException aggregate)
        {
            foreach (var inner in aggregate.Flatten().InnerExceptions)
            {
                foreach (var e in Unwrap(inner))
                {
                    yield return e;
                }
            }

            yield break;
        }

        for (Exception? e = ex; e is not null; e = e.InnerException)
        {
            yield return e;
        }
    }
}
