using System.Text.Json;

namespace Processor.Analyst.Model;

/// <summary>Who spoke. There is no system role here — the system prompt is passed separately.</summary>
internal enum ModelRole { User, Assistant }

/// <summary>
/// One tool call the model asked for. <paramref name="Input"/> stays a <see cref="JsonElement"/>
/// rather than a typed object because the loop validates it against the tool's own schema before
/// binding — server-side <c>strict</c> enforcement does not exist on the on-prem path, so the client
/// must never assume a well-formed input.
/// </summary>
internal sealed record ModelToolCall(string CallId, string ToolName, JsonElement Input)
{
    /// <summary>
    /// Provider-opaque state belonging to the assistant turn this call arrived in, set by the adapter
    /// that produced the call and interpretable ONLY by that adapter.
    /// <para>
    /// <b>Nothing above the seam may read this, and nothing above the seam needs to.</b> It exists
    /// because some backends require an assistant turn to be echoed back byte-for-byte rather than
    /// reconstructed from its visible parts — this endpoint returns a <c>reasoning_content</c> field
    /// that its documentation requires returned unchanged on assistant turns carrying tool calls, and
    /// that cannot be rebuilt from the turn's visible parts. The loop already copies
    /// <see cref="ModelReply.ToolCalls"/> into the transcript unchanged, so parking the state here is
    /// what lets it round-trip without the loop growing a notion of "thinking" it must not have (see
    /// <see cref="IAnalystModel"/>). An adapter with nothing to carry leaves it null; a transcript
    /// built by hand, as every test does, leaves it null and the adapter falls back to reconstruction.
    /// </para>
    /// </summary>
    internal object? ProviderEcho { get; init; }
}

/// <summary>One tool result going back. <paramref name="IsError"/> is returned rather than dropped: a
/// call with no matching result is rejected by the API.</summary>
internal sealed record ModelToolResult(string CallId, string Content, bool IsError);

/// <summary>
/// One entry in the transcript the loop maintains.
/// <para>
/// <b>All tool results for one assistant turn belong in a single user turn.</b> Splitting them across
/// several silently trains the model to stop making parallel calls.
/// </para>
/// </summary>
internal sealed record ModelTurn(
    ModelRole Role,
    string? Text,
    IReadOnlyList<ModelToolCall> ToolCalls,
    IReadOnlyList<ModelToolResult> ToolResults);

/// <summary>
/// A tool as the model sees it. The schema stays raw JSON so the adapter can hand it to the wire
/// unchanged rather than re-modelling it, and so the loop's own client-side validation checks the same
/// text the backend was given.
/// </summary>
internal sealed record ToolSpec(string Name, string Description, string InputSchemaJson);

/// <summary>
/// What came back. Token counts are reported so the loop can enforce its own ceiling — the
/// authoritative budget is loop-enforced precisely because no budget the backend might offer is
/// something the loop may depend on.
/// </summary>
internal sealed record ModelReply(
    IReadOnlyList<ModelToolCall> ToolCalls,
    string? Text,
    int InputTokens,
    int OutputTokens)
{
    /// <summary>A reply that is nothing but the given calls. Test convenience, and the common shape.</summary>
    internal static ModelReply Of(params ModelToolCall[] calls) => new(calls, null, 0, 0);
}
