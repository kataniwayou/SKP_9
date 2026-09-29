namespace Processor.Analyst.Bit;

/// <summary>
/// Per-replica, in memory, bounded, and lost on restart — which the deploy loop causes constantly.
/// <para>
/// <b>That scope is the design, not a limitation.</b> Each replica proves its own fitness with its
/// own model backend and its own wiring, and a proof is only as good as the process holding it. A
/// Redis-backed store was built to make the verdict identical across replicas and survive restarts;
/// it was removed again, because it kept serving a proof about a process that no longer existed.
/// Losing the entry on restart is what re-earns the proof against the image actually running, and
/// it is also the only thing that ever clears a verdict drawn badly.
/// </para>
/// <para>
/// One or two entries is the realistic working set. The bound exists because a cache keyed on payload
/// content is otherwise a slow leak if anything churns.
/// </para>
/// </summary>
internal sealed class BitCache(int capacity)
{
    private readonly Dictionary<string, FitnessVerdict> _entries = [];
    private readonly Queue<string> _order = new();
    private readonly object _gate = new();

    internal bool TryGet(string hash, out FitnessVerdict verdict)
    {
        lock (_gate)
        {
            return _entries.TryGetValue(hash, out verdict!);
        }
    }

    internal void Put(string hash, FitnessVerdict verdict)
    {
        lock (_gate)
        {
            if (!_entries.TryAdd(hash, verdict))
            {
                return;
            }

            _order.Enqueue(hash);

            while (_order.Count > capacity)
            {
                _entries.Remove(_order.Dequeue());
            }
        }
    }
}
