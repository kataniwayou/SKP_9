namespace Messaging.Contracts;

/// <summary>
/// How a step ended, as the orchestrator reads it off a <see cref="StepOutcome"/>.
/// <para>
/// <b>The numbers are pinned to the API's <c>StepEntryCondition</c>, and that is the whole point of
/// them.</b> A successor's entry condition is stored as that enum's underlying int, so advancement is
/// the direct comparison <c>condition == (int)result</c> (or <c>condition == 4</c>, <c>Always</c>).
/// Renumbering either side silently re-points every gated edge in every workflow already in the
/// database, so these are wire values: they may be added to, never reordered.
/// </para>
/// <para>
/// <b><c>PreviousProcessing</c> (0) has no member here, deliberately.</b> Nothing in this system emits
/// a "still processing" result — a step reaches exactly one of the three terminals below — so a
/// successor wired to condition 0 can never be entered. That is a validation rule rather than
/// a result this enum should invent a member for, and the API now enforces it: both step validators
/// reject <c>PreviousProcessing</c>. Rows written before that rule existed can still hold 0, and they
/// behave as they always did — no successor ever matches them.
/// </para>
/// </summary>
public enum StepResult
{
    /// <summary>The step produced output. <see cref="StepOutcome.EntryId"/> names the output blob.</summary>
    Completed = 1,

    /// <summary>
    /// The step failed. <see cref="StepOutcome.EntryId"/> names the step's own input, which is still
    /// in the store — see that field's remarks.
    /// </summary>
    Failed = 2,

    /// <summary>
    /// The step ended its branch and said so. Distinct from ending silently, which is also
    /// legitimate: this exists for the case where a successor gated on a cancelled predecessor needs
    /// to know. <see cref="StepOutcome.EntryId"/> names the input, as for <see cref="Failed"/>.
    /// </summary>
    Cancelled = 3,
}
