namespace Processor.Analyst.Bit;

/// <summary>
/// Per-replica, in memory, bounded, and lost on restart — which the deploy loop causes constantly.
/// That is correct rather than a limitation: each replica proves its own fitness with its own model
/// backend and its own wiring, and a proof is only as good as the process holding it.
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
