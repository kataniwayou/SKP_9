using Cronos;
using Messaging.Contracts.Projections;

namespace Orchestrator.Scheduling;

/// <summary>
/// A thin Cronos wrapper: the next absolute fire time of a stored cron expression, and nothing else.
/// <para>
/// <b>It never throws, and that is the whole point.</b> Hydration walks every workflow in L2 in one
/// pass, so a single expression that will not parse must cost that pass one skipped workflow rather
/// than the whole pass. A bad expression can be there — it reached L2 through validation, and
/// validation can be changed or bypassed — so this returns null for it, exactly as it returns null for
/// a well-formed expression that has no future occurrence. The caller cannot usefully tell the two
/// apart anyway: in both cases there is no time to fire at.
/// </para>
/// <para>
/// <b>The skip is logged by the caller, not here.</b> Only the caller knows which workflow it was
/// reading, and the workflow id is the useful half. The expression itself is never logged: it is user
/// data.
/// </para>
/// <para>
/// The 5- or 6-field form is resolved up front from the shared <see cref="CronFieldForm"/> rule rather
/// than by parsing twice and catching, so "the validator accepts what the scheduler parses" is one
/// rule in one place.
/// </para>
/// </summary>
public static class CronInterval
{
    /// <summary>
    /// The next strictly-future occurrence of <paramref name="cron"/> after <paramref name="utcNow"/>,
    /// or null when <paramref name="cron"/> is null or blank, will not parse, or has no future
    /// occurrence.
    /// </summary>
    /// <param name="cron">
    /// A 5-field standard or 6-field seconds cron expression. Nullable on purpose: the thing callers
    /// hold is <c>WorkflowRootProjection.Cron</c>, which is <c>string?</c> because a null cron is a
    /// valid projection meaning unscheduled. Taking a non-nullable string here would push every caller
    /// into a null check whose only possible answer is the one this method already gives, and under
    /// TreatWarningsAsErrors a caller that skipped it would not compile.
    /// </param>
    /// <param name="utcNow">
    /// The reference instant, which must be <see cref="DateTimeKind.Utc"/> — Cronos rejects anything
    /// else, and a caller feeding wall-clock local time would compute fire times silently offset by
    /// its own timezone. Callers pass <c>TimeProvider.GetUtcNow().UtcDateTime</c>.
    /// </param>
    public static DateTime? NextOccurrence(string? cron, DateTime utcNow)
    {
        if (string.IsNullOrWhiteSpace(cron) || !CronFieldForm.IsValidFieldCount(cron))
        {
            return null;
        }

        var format = CronFieldForm.IsSecondsForm(cron) ? CronFormat.IncludeSeconds : CronFormat.Standard;

        try
        {
            return CronExpression.Parse(cron, format).GetNextOccurrence(utcNow);
        }
        catch (CronFormatException)
        {
            // The field count was right but the fields were not. Same outcome as no occurrence: there
            // is nothing to fire at, and the caller skips this workflow rather than dying on it.
            return null;
        }
    }
}
