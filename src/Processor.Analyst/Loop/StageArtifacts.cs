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
    private readonly Dictionary<string, (int Ordinal, JsonElement Input)> _byName = [];
    private int _next;

    internal void Record(string toolName, JsonElement input)
        => _byName[toolName] = (++_next, input.Clone());

    internal bool Has(string toolName) => _byName.ContainsKey(toolName);

    internal JsonElement Get(string toolName) => _byName[toolName].Input;

    /// <summary>Where this stage sits in the recorded sequence, or <c>int.MaxValue</c> if absent.</summary>
    internal int OrdinalOf(string toolName)
        => _byName.TryGetValue(toolName, out var v) ? v.Ordinal : int.MaxValue;
}
