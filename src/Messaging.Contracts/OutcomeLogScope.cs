namespace Messaging.Contracts;

/// <summary>
/// The step outcome as a log-scope key, so a processor's own records can carry the same
/// <c>Result</c> attribute the orchestrator already emits through <c>StepOutcomeHandler</c>'s
/// message-template parameters.
/// <para>
/// <b>A scope, not a template parameter.</b> Appending <c>{Result}</c> to any of the six lines this
/// backs would change <c>body.text</c>, and <c>body.text</c> is indexed as a keyword in this
/// deployment — a saved query matching one of those lines today would stop matching. The scope
/// bridges to <c>attributes.Result</c> through the same OpenTelemetry <c>IncludeScopes</c> +
/// <c>ParseStateValues</c> path <see cref="ExecutionLogScope"/> already uses for the execution ids,
/// so the rendered text is untouched and the structured field appears anyway. This is precisely the
/// tradeoff <see cref="ExecutionLogScope"/> documents for the ids: "what was findable by text stays
/// findable by text."
/// </para>
/// <para>
/// <b>The key is named <c>Result</c>, matching the orchestrator's own parameter name.</b> Both sides
/// render one enum onto one field, and the field is queried across both — <c>attributes.Result:
/// "Failed"</c> is meant to span a processor's Warning line and the orchestrator's Result-bearing
/// completion line without a hand-join on <c>ExecutionId</c>. A different key here would defeat that.
/// </para>
/// </summary>
public static class OutcomeLogScope
{
    public const string Result = "Result";

    /// <summary>
    /// Builds the scope dictionary carrying the outcome.
    /// <para>
    /// <b><c>result.ToString()</c>, never a hand-typed string.</b> The orchestrator renders this same
    /// enum through a message-template parameter — <c>{Result}</c> in <c>StepOutcomeHandler</c> — and
    /// <see cref="StepResult"/>'s own member names (<c>Completed</c>, <c>Failed</c>, <c>Cancelled</c>)
    /// are exactly the strings that field is expected to hold. Typing those strings by hand at each
    /// call site would give one field name two independently-maintained vocabularies; a rename or a
    /// new member on the enum would silently desync them, and nothing would fail to compile to say
    /// so. Deriving the value from the enum makes that class of drift impossible rather than merely
    /// disciplined.
    /// </para>
    /// </summary>
    public static IReadOnlyDictionary<string, object> BuildScope(StepResult result)
        => new Dictionary<string, object> { [Result] = result.ToString() };
}
