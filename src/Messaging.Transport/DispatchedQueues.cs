using System.Collections.Concurrent;

namespace Messaging.Transport;

/// <summary>What a depth probe learned about one queue on one pass.</summary>
public enum ProbeOutcome
{
    /// <summary>The broker answered. The queue is there.</summary>
    Ok,

    /// <summary>The broker said 404. The queue does not exist.</summary>
    Missing,

    /// <summary>Something else went wrong — most often the broker being unreachable.</summary>
    Failed,
}

/// <summary>
/// Every queue this process has sent work to, so something that OUTLIVES a consumer can measure how
/// deep that consumer's queue is getting.
/// <para>
/// <b>This exists because the obvious design is blind exactly when it matters.</b> A depth probe
/// registered on the consumer's own host measures its queue only while that host is alive — and the
/// queue fills precisely when it is not. Measured against the broker with the processor scaled to
/// zero, the real depth went 0 → 3 with 0 consumers while the gauge read a confident 0 throughout,
/// because the departed pods' last samples were held by the collector and Prometheus's lookback.
/// A probe cannot report the consequence of its own host being gone.
/// </para>
/// <para>
/// <b>Recording happens in <see cref="QueueSender"/>, not at call sites.</b> It was at call sites
/// first — two hand-placed calls in the orchestrator — and that covered the processor's work queue
/// and nothing else. Re-running the orchestrator-outage scenario showed the same blind spot from
/// the other side: the orchestrator is the only process probing its own queues, so with it scaled
/// to zero the number of queues observed anywhere fell from 7 to 1 and `Queues unconsumed` read a
/// confident 0 — unable to tell "none unconsumed" from "six unobservable". Every send passes
/// through one method; recording there is what makes the coverage complete instead of
/// remembered.
/// </para>
/// <para>
/// <b>Why a send record rather than a config list or a store lookup.</b> Queue names are per-
/// processor and per-replica GUIDs resolved at run time, so there is no static list to configure.
/// The liveness index in L2 is the wrong source for the same reason the self-probe was: a process
/// that is gone drops out of it precisely when its queue is filling. What survives is the fact that
/// THIS process sent something there — a queue we have dispatched to is, by definition, a queue
/// whose backlog is our problem.
/// </para>
/// <para>
/// <b>A queue is forgotten only when the broker says it is gone, and only persistently.</b>
/// Recording every send means recording the exclusive per-replica reply queues too, and those are
/// deleted when their process dies. Without a way out, the set would grow by one queue per replica
/// generation forever and the probe would spend a round trip per interval on each of them. So a
/// queue that answers 404 on <see cref="MissesBeforeDrop"/> consecutive passes is dropped.
/// </para>
/// <para>
/// <b>Only a 404 counts, which is the distinction that makes this safe.</b> A broker outage fails
/// every queue at once, and treating that as "gone" would empty the registry at the exact moment
/// the backlog it exists to measure was building. An unreachable broker is
/// <see cref="ProbeOutcome.Failed"/> and leaves the count untouched; only
/// <see cref="ProbeOutcome.Missing"/> — the broker itself answering "no such queue" — counts
/// toward a drop.
/// </para>
/// <para>
/// <b>Empty until the first send, which is not a gap.</b> After a restart nothing is registered
/// until work flows, and the first send is also the earliest moment a backlog could exist.
/// </para>
/// </summary>
public static class DispatchedQueues
{
    /// <summary>
    /// Consecutive 404s before a queue is forgotten. Thirty passes is five minutes at the depth
    /// probe's ten-second interval, and the generosity is deliberate: a broker restart re-declares
    /// the topology, and a queue can legitimately answer 404 for an appreciable stretch while that
    /// happens. Dropping a live queue costs a blind spot; keeping a dead one costs a round trip.
    /// </summary>
    internal const int MissesBeforeDrop = 30;

    private static readonly ConcurrentDictionary<string, int> Misses = new(StringComparer.Ordinal);

    /// <summary>Note that this process has sent work to <paramref name="queue"/>. Idempotent.</summary>
    public static void Record(string queue)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(queue);
        Misses.TryAdd(queue, 0);
    }

    /// <summary>
    /// Report what a probe pass learned, so a queue the broker says is gone stops being probed.
    /// Unknown queues are ignored: a statically-configured queue is not this registry's to forget.
    /// </summary>
    public static void Note(string queue, ProbeOutcome outcome)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(queue);

        switch (outcome)
        {
            case ProbeOutcome.Ok:
                // Re-arm rather than assign: a queue that came back must not carry its old count.
                Misses.TryUpdate(queue, 0, Misses.TryGetValue(queue, out var seen) ? seen : 0);
                break;

            case ProbeOutcome.Missing:
                // AddOrUpdate rather than a read-then-write: two probes in one process would
                // otherwise lose a count between them.
                if (Misses.ContainsKey(queue) &&
                    Misses.AddOrUpdate(queue, 1, (_, n) => n + 1) >= MissesBeforeDrop)
                {
                    Misses.TryRemove(queue, out _);
                }

                break;

            case ProbeOutcome.Failed:
            default:
                // Deliberately nothing. See the class note: a broker outage fails every queue, and
                // counting that would empty the registry exactly when it is needed.
                break;
        }
    }

    /// <summary>Every queue recorded so far, in a stable order so log lines are comparable.</summary>
    public static IReadOnlyList<string> Snapshot()
    {
        var queues = Misses.Keys.ToList();
        queues.Sort(StringComparer.Ordinal);
        return queues;
    }

    /// <summary>Test seam. Not used in production, where forgetting a live queue is the bug.</summary>
    internal static void Clear() => Misses.Clear();
}
