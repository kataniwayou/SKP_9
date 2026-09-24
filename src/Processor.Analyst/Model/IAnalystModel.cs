namespace Processor.Analyst.Model;

/// <summary>
/// The model backend, above the wire format.
/// <para>
/// <b>Deliberately not raw SDK message objects.</b> Anthropic speaks <c>tool_use</c>/<c>tool_result</c>
/// and the on-prem <c>kimi-2.5</c> endpoint speaks <c>tool_calls</c>; the loop must not know which. The
/// Anthropic SDK cannot talk to a non-Anthropic endpoint — a base-URL override produces wire-format
/// mismatches, not a working client — so this seam is the only thing that makes one binary shippable
/// to both the connected cluster and the air-gapped machine.
/// </para>
/// <para>
/// Nothing Anthropic-only may become load-bearing above this line: no adaptive thinking, no effort, no
/// task budgets, no server-side schema enforcement. Those are pacing niceties on one adapter, never
/// mechanisms the loop depends on.
/// </para>
/// </summary>
internal interface IAnalystModel
{
    /// <param name="system">The compiled contract plus the delimited payload prompt.</param>
    /// <param name="transcript">The conversation so far, oldest first.</param>
    /// <param name="tools">The full tool catalog for this dispatch.</param>
    Task<ModelReply> SendAsync(
        string system,
        IReadOnlyList<ModelTurn> transcript,
        IReadOnlyList<ToolSpec> tools,
        CancellationToken ct);
}
