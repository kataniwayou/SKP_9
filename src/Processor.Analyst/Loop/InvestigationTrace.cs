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

    /// <summary>The distinct panels read, for the assertions in Task 9.</summary>
    internal IReadOnlySet<string> PanelsRead => _entries.Select(e => e.PanelId).ToHashSet();

    internal void Record(string panelId, bool dataReturned)
        => _entries.Add(new TraceEntry(_entries.Count + 1, panelId, dataReturned));
}
