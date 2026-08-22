namespace BaseApi.Tests.Live.Resilience;

/// <summary>What a run's ledger and its excuses add up to.</summary>
internal enum RunVerdict
{
    /// <summary>Every invariant held.</summary>
    Complete,

    /// <summary>Short, but the run met the fault and something on it says why.</summary>
    Accounted,

    /// <summary>Short with no excuse the fault can carry. This is a lost step.</summary>
    Unaccounted,
}

/// <summary>One run's verdict, with the excuses that earned it.</summary>
internal sealed record RunClassification(
    RunLedger Ledger,
    RunVerdict Verdict,
    IReadOnlyList<string> Excuses,
    bool Straddles);

/// <summary>
/// Turns a ledger into a verdict.
/// <para>
/// <b>Two rules, and the first is the load-bearing one.</b> A run clear of the outage is held to
/// completeness absolutely, excuse or no excuse — otherwise a pipeline that was quietly broken for
/// the whole soak would pass every scenario by pointing at a fault it never met. Only a run whose
/// span touches the window may spend an excuse.
/// </para>
/// </summary>
internal static class RunClassifier
{
    public static RunClassification Classify(
        RunLedger ledger, IReadOnlyCollection<LogRecord> records, FaultWindow window)
    {
        ArgumentNullException.ThrowIfNull(ledger);
        ArgumentNullException.ThrowIfNull(records);
        ArgumentNullException.ThrowIfNull(window);

        var straddles = window.Overlaps(ledger.StartedAt, ledger.EndedAt);

        if (ledger.IsComplete)
        {
            return new RunClassification(ledger, RunVerdict.Complete, [], straddles);
        }

        if (!straddles)
        {
            return new RunClassification(ledger, RunVerdict.Unaccounted, [], straddles);
        }

        var excuses = Excuses(records);

        return new RunClassification(
            ledger,
            excuses.Count > 0 ? RunVerdict.Accounted : RunVerdict.Unaccounted,
            excuses,
            straddles);
    }

    /// <summary>
    /// The closed accounting vocabulary, plus an outcome that reported a non-Completed result.
    /// <para>
    /// The result is read from the record's own <c>Result</c> attribute rather than matched out of
    /// the rendered body: the bridge already lands it as a field, and a substring search is a
    /// second, weaker spelling of a fact the record states.
    /// </para>
    /// </summary>
    private static IReadOnlyList<string> Excuses(IReadOnlyCollection<LogRecord> records)
    {
        var vocabulary = records
            .Where(r => Templates.Accounting.Contains(r.Template, StringComparer.Ordinal))
            .Select(r => r.Template);

        var outcomes = records
            .Where(r => r.Template is Templates.EntryStepCompleted or Templates.TerminalCompleted)
            .Where(r => r.Result is "Failed" or "Cancelled")
            .Select(r => $"{r.Template} = {r.Result}");

        return vocabulary.Concat(outcomes).Distinct(StringComparer.Ordinal).ToList();
    }
}
