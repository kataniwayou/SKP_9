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
/// What the analysis concluded. <c>Drifting</c> or <c>Notable</c> carry at least one insight.
/// <c>Quiet</c> means the analysis ran and nothing correlated into anything wrong; <c>Inconclusive</c>
/// means the model judged the evidence the sources returned unbelievable. Both of those are published
/// too: every run whose facilities worked completes and exports a document, so a consumer can tell a
/// healthy window from a monitor that did not run. Only a facility failure (payload, model, panel
/// source, budget, an invalid reply) fails the step, and that produces no document.
/// </param>
/// <param name="Window">
/// The window actually examined, not the one configured. They diverge the moment a query truncates
/// or a source lags, and the realized one is what makes two consecutive answers comparable.
/// </param>
/// <param name="Target">Which workflow was investigated. Without it a consumer of the topic cannot tell one monitor's finding from another's.</param>
/// <param name="Reason">
/// Why there is no insight -- set on <c>Quiet</c> and <c>Inconclusive</c>, null on a finding. It says
/// what killed each hypothesis or why the evidence could not be believed, not what was healthy.
/// </param>
/// <param name="Insights">
/// What the analyst inferred, never what a panel showed. Each one correlates at least two panels into
/// a cause, a consequence or a contradiction no single panel shows. This replaced a free-text
/// narrative that described the panels back to the operator, which added nothing the dashboards do
/// not already show. Empty exactly when the verdict is <c>Quiet</c> or <c>Inconclusive</c>.
/// </param>
/// <param name="Evidence">The readings the insights rest on, so a reader can disagree with the inference without re-running the investigation.</param>
/// <param name="RuledOut">Hypotheses killed, with the criterion that killed them. Often the more valuable half.</param>
/// <param name="Trace">Which panels were consulted, in order.</param>
/// <param name="Usage">What the finding cost, against the budget that bounded it.</param>
/// <param name="PromptHash">Provenance — the same value the BIT caches on. Model, effort and the contract are compiled, so the image and SourceHash pin the rest.</param>
internal sealed record AnalystFinding(
    string Verdict,
    FindingTarget Target,
    RealizedWindow Window,
    string? Reason,
    IReadOnlyList<FindingInsight> Insights,
    IReadOnlyList<FindingEvidence> Evidence,
    IReadOnlyList<RuledOutHypothesis> RuledOut,
    IReadOnlyList<TraceEntry> Trace,
    FindingUsage Usage,
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

/// <summary>
/// The workflow investigated. <paramref name="Name"/> is read from L2 when the finding is exported and
/// is null when that read fails: a display name must never cost a finding.
/// </summary>
internal sealed record FindingTarget(Guid WorkflowId, string? Name);

/// <summary>
/// One inference, classified (spec D3). Severity is derived, high exactly when deterministic, and is
/// carried so a reader of the topic need not know the rule.
/// </summary>
internal sealed record FindingInsight(
    string Claim, string Why, IReadOnlyList<string> Panels,
    string Classification, string Domain, string Severity, string Onset, IReadOnlyList<string> EvidenceKinds);

/// <summary>
/// The investigation's own spend -- what <see cref="Budget"/> limits -- and, separately, the whole
/// dispatch's. They differ by the fitness gate, which runs before the investigation and outside its
/// budget; reporting only the first would understate what a finding really cost.
/// </summary>
internal sealed record FindingUsage(
    int Calls, long InputTokens, long OutputTokens, int ElapsedSeconds, FindingBudget Budget, DispatchSpend? Dispatch);

/// <summary>The ceilings the investigation ran under, copied from the step payload.</summary>
internal sealed record FindingBudget(int MaxIterations, int MaxTokens, int WallClockSeconds);

/// <summary>Everything the dispatch spent at the model, gate included. Null where no meter is wired.</summary>
internal sealed record DispatchSpend(long Calls, long InputTokens, long OutputTokens);

/// <summary>The window the investigation actually covered, and how much was in it.</summary>
internal sealed record RealizedWindow(DateTimeOffset From, DateTimeOffset To, int SamplesExamined);

/// <summary>One number the narrative rests on, and where it came from.</summary>
internal sealed record FindingEvidence(string PanelId, string Layer, string Label, string Value);

/// <summary>A hypothesis that was killed, and what killed it.</summary>
internal sealed record RuledOutHypothesis(string Hypothesis, string DisconfirmingCriterion, string WhatWasSeen);

/// <summary>One panel consultation, in order. The history range is set when the read asked for one.</summary>
internal sealed record TraceEntry(
    int Ordinal, string PanelId, bool DataReturned, DateTimeOffset? HistoryFrom = null, DateTimeOffset? HistoryTo = null);
