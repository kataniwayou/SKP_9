using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using BaseProcessor.Core.Shared;

namespace Processor.Analyst.Bit;

/// <summary>
/// The BIT's verdicts, shared by every Analyst replica through L2 and gone once the last one dies.
/// <para>
/// <b>One shared entry per prompt:</b> <c>bit:{hash}</c>, so the key is
/// <c>skp:proc:{id}:shared:bit:{hash}</c>, re-armed by every replica's heartbeat. A replica that
/// joins finds the verdict its siblings earned instead of re-paying the ~10-minute gate.
/// </para>
/// <para>
/// <b>What the verdict was proved against rides in the value, not the key.</b> The key is the prompt
/// alone, but a verdict is earned against one model at one effort, under one exam (<see
/// cref="BitPrompt"/>, <see cref="RehearsalPanels"/>, both compiled in). A rolling deploy never lets
/// the entry expire, so a model change or a rebuilt exam would otherwise inherit a verdict proved
/// under the old one. The stamp is the model, the effort and the image's SourceHash; an entry with a
/// different stamp reads as a miss and is overwritten by the fresh judgement.
/// </para>
/// <para>
/// <b>Anything unreadable is a miss.</b> An unreachable store, a malformed value, another model's
/// stamp — each re-runs the gate rather than guessing. That costs a duplicate judgement, never a
/// wrong one.
/// </para>
/// </summary>
internal sealed class BitCache(IProcessorSharedState shared, string modelStamp)
{
    internal const string NamePrefix = "bit:";

    internal static string EntryName(string hash) => NamePrefix + hash;

    /// <summary>What a verdict was proved against: the model id, the reasoning effort, and the
    /// SourceHash of the image that holds the exam.</summary>
    internal static string Stamp(string? modelId, string? effort, string sourceHash)
        => $"{modelId}/{effort}/{sourceHash}";

    /// <summary>
    /// The SourceHash stamped on THIS assembly, the one that compiles the exam in. Read from the
    /// assembly rather than through <c>ISourceHashProvider</c>, which reads the entry assembly: in the
    /// image the two are the same file, but only this one is still the Analyst when hosted elsewhere.
    /// </summary>
    internal static string ExamSourceHash()
        => typeof(BitCache).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
               .FirstOrDefault(a => a.Key == "SourceHash")?.Value
           ?? throw new InvalidOperationException(
               "Processor.Analyst carries no SourceHash metadata, so a shared BIT verdict could not be "
               + "tied to the exam that earned it");

    internal async Task<FitnessVerdict?> GetAsync(string hash)
    {
        var raw = await shared.GetAsync(EntryName(hash)).ConfigureAwait(false);

        if (raw is null)
        {
            return null;
        }

        try
        {
            var stored = JsonSerializer.Deserialize<Stored>(raw);
            return stored is { Verdict: { } verdict } && stored.Model == modelStamp ? verdict : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    internal Task<bool> PutAsync(string hash, FitnessVerdict verdict)
        => shared.SetAsync(EntryName(hash), JsonSerializer.Serialize(new Stored(modelStamp, verdict)));

    private sealed record Stored(
        [property: JsonPropertyName("model")]   string Model,
        [property: JsonPropertyName("verdict")] FitnessVerdict Verdict);
}
