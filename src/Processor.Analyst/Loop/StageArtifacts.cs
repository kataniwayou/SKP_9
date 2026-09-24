using System.Text.Json;

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
/// </summary>
internal sealed class StageArtifacts
{
    private readonly Dictionary<string, (int Ordinal, JsonElement Input, int PanelsReadMark)> _byName = [];
    private int _next;

    /// <param name="panelsReadMark">
    /// How many panels the trace had already recorded a read for at the moment this stage was
    /// recorded. Two self-reported ordinals agreeing on order proves nothing about what was actually
    /// seen -- a model that reads every panel first and only then calls record_plan still has
    /// record_plan's ordinal before record_readings'. This mark is what lets the assertions compare
    /// against the trace itself instead. Defaults to 0 for callers (mostly tests) that only care about
    /// artifact presence and ordinal order, not this stricter pre-commitment check.
    /// </param>
    internal void Record(string toolName, JsonElement input, int panelsReadMark = 0)
        => _byName[toolName] = (++_next, input.Clone(), panelsReadMark);

    internal bool Has(string toolName) => _byName.ContainsKey(toolName);

    internal JsonElement Get(string toolName) => _byName[toolName].Input;

    /// <summary>Where this stage sits in the recorded sequence, or <c>int.MaxValue</c> if absent.</summary>
    internal int OrdinalOf(string toolName)
        => _byName.TryGetValue(toolName, out var v) ? v.Ordinal : int.MaxValue;

    /// <summary>The <see cref="Record"/> mark for this stage, or <c>int.MaxValue</c> if absent.</summary>
    internal int PanelsReadMarkOf(string toolName)
        => _byName.TryGetValue(toolName, out var v) ? v.PanelsReadMark : int.MaxValue;
}
