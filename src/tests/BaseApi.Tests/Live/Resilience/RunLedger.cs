namespace BaseApi.Tests.Live.Resilience;

/// <summary>One invariant that did not hold, and the counts that show it.</summary>
/// <param name="Invariant">"I1" through "I8".</param>
/// <param name="Detail">The relation as it actually stood.</param>
internal sealed record LedgerBreach(string Invariant, string Detail);

/// <summary>
/// One run's template histogram, and the eight relations that decide whether it lost a step.
/// <para>
/// <b>Eight relations rather than a total.</b> Asserting "the run reached 77 records" would pass a run
/// that lost a dispatch and gained a redelivery. Each relation names one hop, so a breach is a
/// diagnosis -- which hop dropped it -- instead of a boolean.
/// </para>
/// <para>
/// Pure by construction: the input is a bag of records and there is no I/O here, which is what lets
/// the oracle be tested hermetically. An oracle only exercisable by a five-minute live run against a
/// shared cluster is one nobody will trust enough to act on.
/// </para>
/// </summary>
internal sealed class RunLedger
{
    private readonly IReadOnlyDictionary<string, int> _counts;

    private RunLedger(
        string correlationId,
        DateTimeOffset startedAt,
        DateTimeOffset endedAt,
        IReadOnlyDictionary<string, int> counts,
        IReadOnlyList<LedgerBreach> breaches)
    {
        CorrelationId = correlationId;
        StartedAt = startedAt;
        EndedAt = endedAt;
        _counts = counts;
        Breaches = breaches;
    }

    public string CorrelationId { get; }

    /// <summary>The first record of the run -- in a complete run, the entry dispatch.</summary>
    public DateTimeOffset StartedAt { get; }

    /// <summary>The last record of the run.</summary>
    public DateTimeOffset EndedAt { get; }

    /// <summary>Every invariant that did not hold. Empty means complete.</summary>
    public IReadOnlyList<LedgerBreach> Breaches { get; }

    public bool IsComplete => Breaches.Count == 0;

    /// <summary>How many records this run emitted for one template. Zero for an absent bucket.</summary>
    public int Count(string template) => _counts.TryGetValue(template, out var n) ? n : 0;

    public static RunLedger From(
        string correlationId, IReadOnlyCollection<LogRecord> records, WorkflowShape shape)
    {
        ArgumentNullException.ThrowIfNull(records);
        ArgumentNullException.ThrowIfNull(shape);

        var counts = Templates.Ledger.ToDictionary(
            template => template,
            template => records.Count(r => r.Template == template),
            StringComparer.Ordinal);

        var dispatched = counts[Templates.EntryDispatched] + counts[Templates.HandoffDispatched];
        var breaches = new List<LedgerBreach>();

        Require(breaches, "I1", counts[Templates.RunningTheStep] == dispatched,
            $"steps started {counts[Templates.RunningTheStep]}, dispatches sent {dispatched}");

        Require(breaches, "I2", counts[Templates.StepReturned] == counts[Templates.RunningTheStep],
            $"steps returned {counts[Templates.StepReturned]}, started {counts[Templates.RunningTheStep]}");

        // Against the shape's BRANCH count, not the return count. Those were the same number only
        // while every step sent exactly one branch per execution; the entry step now opens two
        // lineages from its single execution, so a run legitimately persists one more branch than it
        // returned steps and the old equality read that surplus as a breach.
        Require(breaches, "I3", counts[Templates.BranchCompleted] == shape.Branches,
            $"branches persisted {counts[Templates.BranchCompleted]} of {shape.Branches}"
            + $", steps returned {counts[Templates.StepReturned]}");

        Require(breaches, "I4", counts[Templates.HandoffDispatched] == counts[Templates.HandedOff],
            $"handoffs dispatched {counts[Templates.HandoffDispatched]}, decided {counts[Templates.HandedOff]}");

        Require(breaches, "I5",
            dispatched == shape.Dispatches && counts[Templates.TerminalCompleted] == shape.Terminals,
            $"dispatches {dispatched} of {shape.Dispatches}, "
            + $"terminals {counts[Templates.TerminalCompleted]} of {shape.Terminals}");

        Require(breaches, "I6", counts[Templates.AuthorConfig] == counts[Templates.RunningTheStep],
            $"author records {counts[Templates.AuthorConfig]}, "
            + $"framework records {counts[Templates.RunningTheStep]} -- a mismatch is log loss, not step loss");

        Require(breaches, "I7",
            counts[Templates.AdvancedSuccessors] + counts[Templates.TerminalCompleted]
                == counts[Templates.BranchCompleted],
            $"advances {counts[Templates.AdvancedSuccessors]} plus terminals "
            + $"{counts[Templates.TerminalCompleted]}, branches persisted {counts[Templates.BranchCompleted]}");

        // Against the shape's ENTRY BRANCH count, not the entry dispatch count. The orchestrator
        // reports one entry outcome per branch the entry step sent, and the two were the same number
        // only while it sent exactly one. The entry step now opens two lineages from its single
        // dispatch, so the old equality read the second lineage's outcome as an unexplained surplus.
        Require(breaches, "I8", counts[Templates.EntryStepCompleted] == shape.EntryBranches,
            $"entry outcomes {counts[Templates.EntryStepCompleted]} of {shape.EntryBranches}"
            + $", entry dispatches {counts[Templates.EntryDispatched]}");

        return new RunLedger(
            correlationId,
            records.Count == 0 ? default : records.Min(r => r.Timestamp),
            records.Count == 0 ? default : records.Max(r => r.Timestamp),
            counts,
            breaches);
    }

    private static void Require(List<LedgerBreach> breaches, string invariant, bool held, string detail)
    {
        if (!held)
        {
            breaches.Add(new LedgerBreach(invariant, detail));
        }
    }
}
