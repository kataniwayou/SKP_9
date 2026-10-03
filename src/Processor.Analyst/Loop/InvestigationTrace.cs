using Processor.Analyst.Panels;

namespace Processor.Analyst.Loop;

/// <summary>
/// What the loop actually executed, in order.
/// <para>
/// <b>Assembled here, never supplied by the model.</b> A model-supplied trace is a claim about what
/// happened; this one is what happened. That difference is the whole reason the trace exists — it is
/// how a reader tells "checked the ops layer and it was clean" from "never looked", and a claim
/// cannot settle that question.
/// </para>
/// </summary>
internal sealed class InvestigationTrace
{
    private readonly List<TraceEntry> _entries = [];

    internal IReadOnlyList<TraceEntry> Entries => _entries;

    /// <summary>The distinct panels read, for the cross-reference assertions in <c>StageAssertions</c>.</summary>
    internal IReadOnlySet<string> PanelsRead => _entries.Select(e => e.PanelId).ToHashSet();

    /// <summary>
    /// The samples every read returned, summed. A no-finding document has no model-reported count to
    /// carry, so this is what fills its window -- the loop's own record again, not a claim.
    /// </summary>
    internal int SamplesRead { get; private set; }

    private readonly List<TimeRange?> _ranges = [];

    /// <summary>Parallel to <see cref="Entries"/>: the history range served, or null for a window read.</summary>
    internal IReadOnlyList<TimeRange?> Ranges => _ranges;

    internal void Record(string panelId, bool dataReturned, int samples = 0, TimeRange? history = null)
    {
        _entries.Add(new TraceEntry(_entries.Count + 1, panelId, dataReturned));
        _ranges.Add(history);
        SamplesRead += samples;
    }
}
