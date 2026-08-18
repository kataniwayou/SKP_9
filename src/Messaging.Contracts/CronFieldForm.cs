namespace Messaging.Contracts.Projections;

/// <summary>
/// Maps a cron expression's field count to the format it should be parsed as. Pure string logic
/// with no Cronos dependency, keeping the contracts leaf parser-free. The scheduler and the API
/// validators both use this one rule, so "the validator accepts exactly what the scheduler parses"
/// cannot drift. Six tokens is the seconds form, five the standard form; any other count is invalid.
/// </summary>
public static class CronFieldForm
{
    /// <summary>true for the 6-field seconds form, false for the 5-field standard form.</summary>
    public static bool IsSecondsForm(string expr) => FieldCount(expr) == 6;

    /// <summary>true when the expression has a usable 5- or 6-field count. Callers reject when this
    /// is false, before handing the expression to a cron parser.</summary>
    public static bool IsValidFieldCount(string expr) => FieldCount(expr) is 5 or 6;

    private static int FieldCount(string expr) =>
        string.IsNullOrWhiteSpace(expr)
            ? 0
            : expr.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Length;
}
