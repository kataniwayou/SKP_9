using StackExchange.Redis;

namespace BaseConsole.Core.Gating;

/// <summary>
/// Decides whether a failure against the projection store is a reason to wait, or a reason to give
/// up on the message.
/// <para>
/// This is the single most consequential branch in the consumer. Classified transient, a message is
/// returned to the queue and retried once the store recovers. Classified deterministic, it is parked
/// and a human has to look at it. Getting the first wrong parks work that would have succeeded; the
/// second wrong requeues a message that can never succeed, forever.
/// </para>
/// </summary>
public static class L2FaultClassifier
{
    /// <summary>
    /// True when the failure is the store being unreachable rather than the message being wrong.
    /// <para>
    /// <b>The whole exception chain is walked, not just the outermost type.</b> A handler that wraps
    /// its failure, or one that fails inside a combinator and surfaces an aggregate, would otherwise
    /// fall through to the deterministic branch — turning a transient outage into permanently parked
    /// work, which is the most expensive mistake available here.
    /// </para>
    /// <para>
    /// <b>A server-side error is deliberately excluded.</b> It covers genuine command errors as well
    /// as transient server states, and treating a rejected command as transient would requeue a
    /// message the store will refuse every time.
    /// </para>
    /// </summary>
    public static bool IsTransient(Exception ex) =>
        Unwrap(ex).Any(e => e is RedisConnectionException or RedisTimeoutException);

    /// <summary>Flattens aggregates and walks inner exceptions, yielding every exception in the chain.</summary>
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
