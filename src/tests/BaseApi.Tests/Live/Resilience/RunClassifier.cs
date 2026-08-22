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
/// <para>
/// <b>An excuse comes from one of two tiers.</b> A run-scoped excuse is a record on the run's own
/// <c>CorrelationId</c> — logged inside a handler, after deserialization, where that id is readable.
/// A process-scoped excuse is never on the run's own records: <c>GatedQueueConsumer</c> logs it from
/// a catch block above the deserialization boundary, where the correlation, workflow, and step ids
/// are still undecoded bytes. It cannot name the run it interrupted, so instead it corroborates the
/// window — a straddling short run is accounted if a process-scoped excuse appears anywhere in the
/// window, whether or not it names this run. That is weaker than a per-run attribution; it is the
/// strongest claim these records can support, not a compromise chosen for convenience.
/// </para>
/// </summary>
internal static class RunClassifier
{
    public static RunClassification Classify(
        RunLedger ledger,
        IReadOnlyCollection<LogRecord> records,
        FaultWindow window,
        IReadOnlyCollection<string> windowExcuses)
    {
        ArgumentNullException.ThrowIfNull(ledger);
        ArgumentNullException.ThrowIfNull(records);
        ArgumentNullException.ThrowIfNull(window);
        ArgumentNullException.ThrowIfNull(windowExcuses);

        var straddles = window.Overlaps(ledger.StartedAt, ledger.EndedAt);

        if (ledger.IsComplete)
        {
            return new RunClassification(ledger, RunVerdict.Complete, [], straddles);
        }

        if (!straddles)
        {
            return new RunClassification(ledger, RunVerdict.Unaccounted, [], straddles);
        }

        var runExcuses = Excuses(records);
        var accounted = runExcuses.Count > 0 || windowExcuses.Count > 0;

        // Window-level excuses are reported alongside the run's own, tagged so a reader of
        // SoakReport can tell "this run says why" from "the process said why, somewhere in the
        // window, and this run happened to be short while it was true."
        var excuses = windowExcuses.Count == 0
            ? runExcuses
            : runExcuses
                .Concat(windowExcuses.Select(e => $"window: {e}"))
                .Distinct(StringComparer.Ordinal)
                .ToList();

        return new RunClassification(
            ledger,
            accounted ? RunVerdict.Accounted : RunVerdict.Unaccounted,
            excuses,
            straddles);
    }

    /// <summary>
    /// The run-scoped accounting vocabulary, plus an outcome that reported a non-Completed result.
    /// <para>
    /// The result is read from the record's own <c>Result</c> attribute rather than matched out of
    /// the rendered body: the bridge already lands it as a field, and a substring search is a
    /// second, weaker spelling of a fact the record states.
    /// </para>
    /// </summary>
    private static IReadOnlyList<string> Excuses(IReadOnlyCollection<LogRecord> records)
    {
        var vocabulary = records
            .Where(r => Templates.RunScopedExcuses.Contains(r.Template, StringComparer.Ordinal))
            .Select(r => r.Template);

        var outcomes = records
            .Where(r => r.Template is Templates.EntryStepCompleted or Templates.TerminalCompleted)
            .Where(r => r.Result is "Failed" or "Cancelled")
            .Select(r => $"{r.Template} = {r.Result}");

        return vocabulary.Concat(outcomes).Distinct(StringComparer.Ordinal).ToList();
    }
}
