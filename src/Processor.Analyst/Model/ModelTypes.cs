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
internal sealed record ModelToolCall(string CallId, string ToolName, JsonElement Input);

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

/// <summary>A tool as the model sees it. The schema is raw JSON so both adapters can hand it on unchanged.</summary>
internal sealed record ToolSpec(string Name, string Description, string InputSchemaJson);

/// <summary>
/// What came back. Token counts are reported so the loop can enforce its own ceiling — the
/// authoritative budget is loop-enforced precisely because Anthropic's task budgets do not exist on
/// the on-prem path.
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
