using System.Text.Json;
using System.Text.Json.Serialization;

namespace Processor.Analyst;

/// <summary>
/// The document written to L2 and shipped by KafkaExporter. Its field list is frozen once the schema
/// row is referenced, so this is the expensive one to get wrong.
/// <para>
/// <b>Deliberately excluded: severity and any recommended action.</b> Severity belongs to whoever
/// consumes the Kafka message and knows who is on call; an agent that ranks its own findings starts
/// optimizing for being noticed. A recommendation invites someone to act on a read-only agent's
/// guess, which is the door the future whitelist opens deliberately rather than by suggestion.
/// </para>
/// </summary>
/// <param name="Verdict">
/// <c>Drifting</c> or <c>Notable</c>. There is no <c>Quiet</c> and no <c>Indeterminate</c>: a quiet
/// run cancels and an unanalysable one fails, so neither ever reaches a document.
/// </param>
/// <param name="Window">
/// The window actually examined, not the one configured. They diverge the moment a query truncates
/// or a source lags, and the realized one is what makes two consecutive answers comparable.
/// </param>
/// <param name="Narrative">The prose an operator reads. The only part that needs the model.</param>
/// <param name="Evidence">The numbers the narrative rests on, so a reader can disagree with the explanation without re-running the investigation.</param>
/// <param name="RuledOut">Hypotheses killed, with the criterion that killed them. Often the more valuable half.</param>
/// <param name="Trace">Which panels were consulted, in order.</param>
/// <param name="PromptHash">Provenance — the same value the BIT caches on. Model, effort and the contract are compiled, so the image and SourceHash pin the rest.</param>
internal sealed record AnalystFinding(
    string Verdict,
    RealizedWindow Window,
    string Narrative,
    IReadOnlyList<FindingEvidence> Evidence,
    IReadOnlyList<RuledOutHypothesis> RuledOut,
    IReadOnlyList<TraceEntry> Trace,
    string PromptHash)
{
    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    /// <summary>The bytes handed to <c>SendToPostAsync</c>.</summary>
    internal static byte[] Serialize(AnalystFinding finding)
        => JsonSerializer.SerializeToUtf8Bytes(finding, Options);
}

/// <summary>The window the investigation actually covered, and how much was in it.</summary>
internal sealed record RealizedWindow(DateTimeOffset From, DateTimeOffset To, int SamplesExamined);

/// <summary>One number the narrative rests on, and where it came from.</summary>
internal sealed record FindingEvidence(string PanelId, string Layer, string Label, string Value);

/// <summary>A hypothesis that was killed, and what killed it.</summary>
internal sealed record RuledOutHypothesis(string Hypothesis, string DisconfirmingCriterion, string WhatWasSeen);

/// <summary>One panel consultation, in order.</summary>
internal sealed record TraceEntry(int Ordinal, string PanelId, bool DataReturned);
