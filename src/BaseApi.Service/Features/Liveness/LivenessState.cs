namespace BaseApi.Service.Features.Liveness;

/// <summary>
/// The hub's current state and its sequence counter. The monitor feeds it each reading (<see cref="Apply"/>) or each
/// failed read (<see cref="Fail"/>); it answers with the changes to broadcast, each with the next sequence number, and
/// the hub's <see cref="Snapshot"/> reads it. One lock: a snapshot's sequence is always the number of the last change
/// it includes, so a client that skips changes up to it and applies the ones after it misses nothing.
/// <para>
/// <b>Changes only.</b> A reading equal to the last one broadcasts nothing. The first reading broadcasts one
/// <see cref="MonitorStatusDto"/> (known) and no entity changes: a client takes a snapshot when it sees it.
/// </para>
/// </summary>
public sealed class LivenessState
{
    private readonly object _gate = new();
    private readonly TaskCompletionSource _first = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private LivenessReading? _current;
    private bool _known;
    private int _failures;
    private long _sequence;

    /// <summary>Completes when the first reading has been applied.</summary>
    public Task FirstReading => _first.Task;

    /// <summary>The last sequence number handed out (0 before any change).</summary>
    public long Sequence { get { lock (_gate) return _sequence; } }

    /// <summary>
    /// Takes a reading: the changes against the last one, in a stable order (a monitor status first when the state was
    /// unknown, then workflows by id, then processors by id), each with the next sequence number.
    /// </summary>
    public IReadOnlyList<object> Apply(LivenessReading reading)
    {
        ArgumentNullException.ThrowIfNull(reading);
        var changes = new List<object>();
        lock (_gate)
        {
            var previous = _current;
            _current = reading;
            _failures = 0;
            if (!_known)
            {
                _known = true;
                changes.Add(new MonitorStatusDto(true, null, ++_sequence));
            }
            if (previous is not null)
            {
                var started = reading.Running.Except(previous.Running).Select(id => (Id: id, Running: true));
                var stopped = previous.Running.Except(reading.Running).Select(id => (Id: id, Running: false));
                foreach (var (id, running) in started.Concat(stopped).OrderBy(c => c.Id))
                {
                    changes.Add(new WorkflowLiveDto(id, running, ++_sequence));
                }
                foreach (var (id, now) in reading.Processors.OrderBy(p => p.Key))
                {
                    if (previous.Processors.TryGetValue(id, out var was) && was == now) continue;
                    changes.Add(new ProcessorLivenessChangeDto(id, now.Live, now.Healthy, now.Replicas, now.Reason, false, ++_sequence));
                }
                foreach (var id in previous.Processors.Keys.Where(k => !reading.Processors.ContainsKey(k)).Order())
                {
                    changes.Add(new ProcessorLivenessChangeDto(id, false, 0, 0, null, true, ++_sequence));
                }
            }
        }
        _first.TrySetResult();
        return changes;
    }

    /// <summary>
    /// A failed read. The state is kept; once <paramref name="unknownAfter"/> reads in a row have failed the hub says
    /// "unknown" (one <see cref="MonitorStatusDto"/>, returned once); null otherwise.
    /// </summary>
    public MonitorStatusDto? Fail(string reason, int unknownAfter)
    {
        lock (_gate)
        {
            _failures++;
            if (!_known || _failures < Math.Max(1, unknownAfter)) return null;
            _known = false;
            return new MonitorStatusDto(false, reason, ++_sequence);
        }
    }

    /// <summary>The whole state and the sequence number of the last change it includes.</summary>
    public LivenessSnapshotDto Snapshot()
    {
        lock (_gate)
        {
            var running = _current?.Running.Order().ToList() ?? [];
            var processors = _current?.Processors.Values.OrderBy(p => p.ProcessorId).ToList() ?? [];
            return new LivenessSnapshotDto(_sequence, _known, running, processors);
        }
    }
}
