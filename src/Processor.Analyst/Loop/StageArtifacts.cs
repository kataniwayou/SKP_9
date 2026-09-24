using System.Text.Json;
using Processor.Analyst.Tools;

namespace Processor.Analyst.Loop;

/// <summary>
/// The five stage artifacts, in the order they were recorded.
/// <para>
/// Order matters as much as presence: a plan recorded after the readings is not a plan. Keeping the
/// ordinal is what makes that checkable.
/// </para>
/// <para>
/// Re-recording a stage is allowed and overwrites — re-planning after execute is explicitly permitted,
/// because an investigation that genuinely needs a second look must not be locked into one pass. The
/// ordinal moves with it.
/// </para>
/// <para>
/// A re-plan does NOT move a hypothesis's own pre-commitment mark forward, though. The mark belongs
/// to the hypothesis, not to whichever record_plan call happens to be the most recent carrier of it:
/// a hypothesis restated verbatim in plan v2 keeps the mark from when it first appeared, in v1, so
/// panels legitimately read between v1 and v2 do not retroactively make v1's carried-forward
/// hypothesis look like it was planned after the fact. A hypothesis introduced for the first time in
/// v2 gets v2's mark, so it is still held to what had already been read by then.
/// </para>
/// <para>
/// "Restated" is judged after <see cref="TextNormalization.Whitespace"/>, not by raw string equality:
/// a hypothesis retyped with a trailing space or a doubled internal space is the same hypothesis, and
/// treating it as a fresh one would silently reopen the exact false rejection the mark exists to
/// avoid, just triggered by formatting drift instead of a genuine re-plan. Not case-folded -- a
/// capitalisation change is plausibly a different claim.
/// </para>
/// </summary>
internal sealed class StageArtifacts
{
    private readonly Dictionary<string, (int Ordinal, JsonElement Input)> _byName = [];
    private readonly Dictionary<string, int> _hypothesisFirstMark = new(StringComparer.Ordinal);
    private int _next;

    /// <param name="panelsReadMark">
    /// How many panels the trace had already recorded a read for at the moment this stage was
    /// recorded. Two self-reported ordinals agreeing on order proves nothing about what was actually
    /// seen -- a model that reads every panel first and only then calls record_plan still has
    /// record_plan's ordinal before record_readings'. For record_plan specifically, this is also the
    /// mark recorded per hypothesis the first time each one appears in any plan (see class remarks).
    /// Defaults to 0 for callers (mostly tests) that only care about artifact presence and ordinal
    /// order, not the stricter pre-commitment checks.
    /// </param>
    internal void Record(string toolName, JsonElement input, int panelsReadMark = 0)
    {
        _byName[toolName] = (++_next, input.Clone());

        if (toolName == ToolNames.RecordPlan)
        {
            foreach (var hypothesis in input.GetProperty("hypotheses").EnumerateArray())
            {
                var name = TextNormalization.Whitespace(hypothesis.GetProperty("hypothesis").GetString()!);

                // TryAdd only: a hypothesis carried forward into a later plan keeps the mark from
                // where it FIRST appeared, not the mark of whichever record_plan call is most recent.
                _hypothesisFirstMark.TryAdd(name, panelsReadMark);
            }
        }
    }

    internal bool Has(string toolName) => _byName.ContainsKey(toolName);

    internal JsonElement Get(string toolName) => _byName[toolName].Input;

    /// <summary>Where this stage sits in the recorded sequence, or <c>int.MaxValue</c> if absent.</summary>
    internal int OrdinalOf(string toolName)
        => _byName.TryGetValue(toolName, out var v) ? v.Ordinal : int.MaxValue;

    /// <summary>
    /// The panels-read mark captured the first time this hypothesis name appeared in any recorded
    /// record_plan, across every re-plan -- or <c>int.MaxValue</c> if this hypothesis was never named.
    /// The lookup is whitespace-normalised (see class remarks), so callers pass the raw name as it
    /// appears in whichever plan they are currently reading; they do not need to normalise it first.
    /// </summary>
    internal int HypothesisMarkOf(string hypothesis)
        => _hypothesisFirstMark.TryGetValue(TextNormalization.Whitespace(hypothesis), out var mark)
            ? mark
            : int.MaxValue;
}
