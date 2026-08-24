using System.Collections.Concurrent;

namespace BaseConsole.Core.Messaging;

/// <summary>
/// Every queue this process has dispatched work to, so something that OUTLIVES the consumer can
/// measure how deep that queue is getting.
/// <para>
/// <b>This exists because the obvious design is blind exactly when it matters.</b>
/// <see cref="QueueDepthProbe"/> was first registered only on the processor, watching its own work
/// queue — which meant the queue was probed solely by the pods whose absence causes it to fill.
/// Measured against the broker with the processor deployment scaled to zero:
/// </para>
/// <code>
///   16:54:23  broker: 0 msgs / 0 consumers   |   instrument depth=0
///   16:54:36  broker: 1 msgs / 0 consumers   |   instrument depth=0
///   16:55:16  broker: 2 msgs / 0 consumers   |   instrument depth=0
///   16:55:43  broker: 3 msgs / 0 consumers   |   instrument depth=0
/// </code>
/// <para>
/// A real backlog formed and the gauge read a confident zero throughout, because the last samples
/// the departed pods exported were held by the collector and by Prometheus's five-minute lookback.
/// That is the stale-held gauge defect the boards already document, reintroduced in its worst form:
/// a probe cannot report the consequence of its own host being gone.
/// </para>
/// <para>
/// <b>Why a dispatch record rather than a config list or a store lookup.</b> Processor queue names
/// are per-processor GUIDs resolved from the workflow graph at run time, so there is no static list
/// to configure. The liveness index in L2 is the wrong source for the same reason the self-probe was
/// — a processor that is gone drops out of it precisely when its queue is filling. What does survive
/// is the fact that THIS process sent something there: a queue we have dispatched to is, by
/// definition, a queue whose backlog is our problem.
/// </para>
/// <para>
/// <b>It never forgets, and that is deliberate.</b> Entries are added and never removed, so a
/// processor that stops being dispatched to keeps being measured. A queue that has genuinely gone
/// away fails its passive declare, which the probe latches as one warning and no series — an honest
/// silence, rather than the confident zero this class exists to prevent. The set is bounded by the
/// number of distinct processors this deployment has ever dispatched to, which is small and does not
/// grow with traffic.
/// </para>
/// <para>
/// <b>Empty until the first dispatch, which is not a gap.</b> After a restart nothing is registered
/// until work flows — and the first dispatch is also the earliest moment a backlog could exist.
/// </para>
/// </summary>
public static class DispatchedQueues
{
    private static readonly ConcurrentDictionary<string, byte> Known = new(StringComparer.Ordinal);

    /// <summary>Note that this process has sent work to <paramref name="queue"/>. Idempotent.</summary>
    public static void Record(string queue)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(queue);
        Known.TryAdd(queue, 0);
    }

    /// <summary>Every queue recorded so far, in a stable order so log lines are comparable.</summary>
    public static IReadOnlyList<string> Snapshot()
    {
        var queues = Known.Keys.ToList();
        queues.Sort(StringComparer.Ordinal);
        return queues;
    }

    /// <summary>Test seam. Not used in production, where forgetting a queue is the bug.</summary>
    internal static void Clear() => Known.Clear();
}
