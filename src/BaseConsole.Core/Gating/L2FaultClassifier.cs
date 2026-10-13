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
    /// <b>A server-side error is transient only for the four states that clear on their own</b>:
    /// <c>OOM</c> (maxmemory reached under <c>noeviction</c>), <c>READONLY</c> (a failover in
    /// progress), <c>LOADING</c> and <c>BUSY</c>. Every other server error is a rejected command —
    /// <c>NOPERM</c>, <c>WRONGTYPE</c>, an unknown command — and requeueing it would retry a message
    /// the store will refuse every time. The match is on the first word of the reply, so
    /// <c>BUSYGROUP</c> is not <c>BUSY</c>.
    /// </para>
    /// </summary>
    public static bool IsTransient(Exception ex) =>
        Unwrap(ex).Any(e => e is RedisConnectionException or RedisTimeoutException || IsTransientServerState(e));

    private static readonly string[] TransientServerStates = ["OOM", "READONLY", "LOADING", "BUSY"];

    private static bool IsTransientServerState(Exception e)
    {
        if (e is not RedisServerException server)
        {
            return false;
        }

        var space = server.Message.IndexOf(' ', StringComparison.Ordinal);
        var word = space < 0 ? server.Message : server.Message[..space];
        return TransientServerStates.Contains(word, StringComparer.Ordinal);
    }

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
