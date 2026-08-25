namespace BaseApi.Tests.Live.Resilience;

/// <summary>One invariant that did not hold, and the counts that show it.</summary>
/// <param name="Invariant">"I1" through "I8".</param>
/// <param name="Detail">The relation as it actually stood.</param>
internal sealed record LedgerBreach(string Invariant, string Detail);

/// <summary>
/// One dispatch that started more than once because an attempt was abandoned mid-execution and the
/// broker redelivered it.
/// </summary>
/// <param name="StepId">The step, or null for the entry step, whose scope carries no step id here.</param>
/// <param name="EntryId">The dispatch's input key, or null for a source step, which has none.</param>
/// <param name="Starts">How many times "running the step" was written for this dispatch.</param>
/// <param name="Returns">How many times "the step returned" was.</param>
internal sealed record SupersededAttempt(string? StepId, string? EntryId, int Starts, int Returns)
{
    /// <summary>Attempts that started and never returned, each superseded by a later one that did.</summary>
    public int Count => Starts - Returns;

    public override string ToString() =>
        $"step {StepId ?? "(entry)"} on entry {EntryId ?? "(source)"}: "
        + $"{Starts} start(s), {Returns} return(s)";
}

/// <summary>
/// One run's template histogram, and the eight relations that decide whether it lost a step.
/// <para>
/// <b>Eight relations rather than a total.</b> Asserting "the run reached 77 records" would pass a run
/// that lost a dispatch and gained a redelivery. Each relation names one hop, so a breach is a
/// diagnosis -- which hop dropped it -- instead of a boolean.
/// </para>
/// <para>
/// <b>The step hops are paired per dispatch, not merely counted.</b> A processor replica that is
/// removed mid-execution never acknowledges the delivery it was working, so the broker redelivers
/// that same message -- byte-identical, ids and all -- to a surviving replica, which runs it to
/// completion. The abandoned attempt leaves a "running the step" with no matching return, and against
/// a bare histogram that reads as a twelfth step start for eleven dispatches: a breach on the two
/// hops that count starts, with nothing in the accounting vocabulary to excuse it, because the
/// replica went away without reaching any catch block. It is the opposite of a lost step -- the
/// redelivery is at-least-once delivery doing exactly its job -- so treating it as one condemns a
/// run that lost nothing.
/// </para>
/// <para>
/// The records already say which dispatch each attempt belongs to. <c>ProcessDispatchHandler</c>
/// scopes its whole hop on the dispatch's ids, so grouping the two step templates by
/// (<c>StepId</c>, <c>EntryId</c>) recovers the dispatch: unique per dispatch within a fire, since a
/// step entered twice arrives under two separately minted entry keys and two successors of one step
/// carry two different step ids. A group with more starts than returns, where at least one attempt
/// DID return, is a redelivery -- the dispatch completed, and the surplus starts are
/// <see cref="Superseded"/>. A group that never returned at all is not: it is a step that started and
/// vanished, and it stays counted as loss.
/// </para>
/// <para>
/// This keeps both start-counting hops sharp rather than blunting either. A dispatch whose only
/// attempt never returned still breaches I2 (a return short of the executions). A dispatch executed
/// twice where BOTH attempts returned -- real double-processing, not a redelivery -- supersedes
/// nothing and still breaches I1 (an execution more than the dispatches sent).
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
        IReadOnlyList<SupersededAttempt> superseded,
        IReadOnlyList<LedgerBreach> breaches)
    {
        CorrelationId = correlationId;
        StartedAt = startedAt;
        EndedAt = endedAt;
        _counts = counts;
        Superseded = superseded;
        Breaches = breaches;
    }

    public string CorrelationId { get; }

    /// <summary>The first record of the run -- in a complete run, the entry dispatch.</summary>
    public DateTimeOffset StartedAt { get; }

    /// <summary>The last record of the run.</summary>
    public DateTimeOffset EndedAt { get; }

    /// <summary>Every invariant that did not hold. Empty means complete.</summary>
    public IReadOnlyList<LedgerBreach> Breaches { get; }

    /// <summary>
    /// Every dispatch that was started, abandoned, and redelivered. Empty in the ordinary case.
    /// <para>
    /// Not a breach and not an excuse -- a fact about how the run reached completeness, kept on the
    /// ledger so a reader of <see cref="SoakReport"/> can see that a replica went away under a step
    /// rather than have the run render identically to one where nothing happened at all.
    /// </para>
    /// </summary>
    public IReadOnlyList<SupersededAttempt> Superseded { get; }

    /// <summary>How many step attempts were abandoned and later superseded by a redelivery.</summary>
    public int SupersededCount => Superseded.Sum(a => a.Count);

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

        var superseded = SupersededAttempts(records);

        // Attempts, minus the ones a redelivery superseded: how many times a dispatch was carried to
        // its end, which is the number the two start-counting hops are actually about. With no
        // redelivery in the run this is the raw count and both relations below are the equalities they
        // always were.
        var started = counts[Templates.RunningTheStep];
        var executions = started - superseded.Sum(a => a.Count);
        var note = superseded.Count == 0
            ? string.Empty
            : $" ({started - executions} superseded by a redelivery)";

        Require(breaches, "I1", executions == dispatched,
            $"steps executed {executions}, dispatches sent {dispatched}"
            + $" -- started {started}{note}");

        Require(breaches, "I2", counts[Templates.StepReturned] == executions,
            $"steps returned {counts[Templates.StepReturned]}, executed {executions}{note}");

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

        // A range rather than an equality, and only ever a range wider than a point when the run
        // carried a redelivery. A superseded attempt was cut off somewhere inside the author's own
        // code, and whether it got as far as the author's config line before its replica went away is
        // not knowable from here and is not an invariant -- so anything from "every superseded attempt
        // reached it" down to "none did" is consistent with no log having been lost. With no
        // redelivery, executions equals started and this is the equality it always was.
        Require(breaches, "I6",
            counts[Templates.AuthorConfig] >= executions && counts[Templates.AuthorConfig] <= started,
            $"author records {counts[Templates.AuthorConfig]}, framework records "
            + (executions == started ? $"{started}" : $"{executions}..{started}")
            + " -- a mismatch is log loss, not step loss");

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
            superseded,
            breaches);
    }

    /// <summary>
    /// The dispatches that were started more than once and did eventually return.
    /// <para>
    /// <b>The <c>Returns > 0</c> filter is the whole discriminator.</b> A dispatch whose attempts all
    /// started and none returned is not a redelivery that succeeded -- it is a step that started and
    /// vanished, exactly what these scenarios exist to catch -- so it is excluded here and left to
    /// breach I2 as a return the run never produced.
    /// </para>
    /// <para>
    /// Grouping on the two ids together rather than on either alone: <c>EntryId</c> alone would merge
    /// two successors of one step, which are dispatched against the one shared entry key, so an
    /// abandoned D1 beside a completed D2 would read as a redelivery of the same dispatch and forgive
    /// a genuine loss. <c>StepId</c> alone would merge the two entries of a step reached from two
    /// predecessors, which is how the seeded workflow's terminal step runs. Neither collision survives
    /// the pair.
    /// </para>
    /// </summary>
    private static IReadOnlyList<SupersededAttempt> SupersededAttempts(
        IReadOnlyCollection<LogRecord> records) =>
        records
            .Where(r => r.Template is Templates.RunningTheStep or Templates.StepReturned)
            .GroupBy(r => (r.StepId, r.EntryId))
            .Select(g => new SupersededAttempt(
                g.Key.StepId,
                g.Key.EntryId,
                g.Count(r => r.Template == Templates.RunningTheStep),
                g.Count(r => r.Template == Templates.StepReturned)))
            .Where(a => a.Returns > 0 && a.Starts > a.Returns)
            .OrderBy(a => a.StepId, StringComparer.Ordinal)
            .ThenBy(a => a.EntryId, StringComparer.Ordinal)
            .ToList();

    private static void Require(List<LedgerBreach> breaches, string invariant, bool held, string detail)
    {
        if (!held)
        {
            breaches.Add(new LedgerBreach(invariant, detail));
        }
    }
}
