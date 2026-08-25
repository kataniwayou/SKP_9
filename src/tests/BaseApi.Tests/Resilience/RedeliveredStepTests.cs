using System.Text.Json;
using BaseApi.Tests.Live.Resilience;
using Xunit;

namespace BaseApi.Tests.Resilience;

/// <summary>
/// The accounting artefact S8 kept tripping over, pinned hermetically.
/// <para>
/// A processor replica removed mid-execution never acknowledges the delivery it was working, so the
/// broker redelivers that message to a surviving replica, which finishes it. The run loses nothing --
/// its terminal step completes -- but it emits one "running the step" that never returns, and a
/// histogram reads that surplus start as a lost step. The replica went away without reaching any
/// catch block, so there is no record in the accounting vocabulary to excuse it and the verdict came
/// out Unaccounted: the harness condemning a run for the recovery mechanism working.
/// </para>
/// <para>
/// Every fixture here is the captured complete run with one record added or removed, so each test
/// says exactly which record makes the difference. The step the surplus start is grafted onto is
/// <see cref="AbandonedStepId"/> -- the step named in the incident these tests were written from.
/// </para>
/// </summary>
public sealed class RedeliveredStepTests
{
    /// <summary>The step whose attempt was abandoned when its replica was removed.</summary>
    private const string AbandonedStepId = "c04aa144-4abb-4856-9391-f13880b9b25c";

    /// <summary>The terminal step, the one the seeded workflow enters twice under two entry keys.</summary>
    private const string TwiceEnteredStepId = "eb42edf2-062d-48be-896e-7860a7370b12";

    private static readonly IReadOnlyList<LogRecord> CompleteRun = LoadFixture();

    /// <summary>A window the whole fixture sits inside, so straddling is never what a test turns on.</summary>
    private static readonly FaultWindow Window = new(
        CompleteRun.Min(r => r.Timestamp) - TimeSpan.FromMinutes(1),
        CompleteRun.Max(r => r.Timestamp) + TimeSpan.FromMinutes(1));

    private static readonly IReadOnlyList<string> NoWindowExcuses = [];

    /// <summary>
    /// The incident itself. One extra start on one dispatch, no extra return, everything else exactly
    /// as captured -- and the ledger holds, because the dispatch that started twice did return.
    /// </summary>
    [Fact]
    public void AnAbandonedAttemptWhoseRedeliveryCompletedIsNotALostStep()
    {
        var ledger = Ledger(WithAbandonedAttempt(AbandonedStepId));

        Assert.True(ledger.IsComplete,
            "the redelivered dispatch returned, so no step was lost: "
            + string.Join("; ", ledger.Breaches.Select(b => $"{b.Invariant}: {b.Detail}")));
    }

    /// <summary>
    /// The verdict that was actually failing S8. A run that lost nothing must not need an excuse, and
    /// there is none available: the replica went away above every catch block, so nothing anywhere
    /// names the run or corroborates the window.
    /// </summary>
    [Fact]
    public void TheIncidentClassifiesCompleteRatherThanUnaccounted()
    {
        var records = WithAbandonedAttempt(AbandonedStepId);

        var classification = RunClassifier.Classify(
            Ledger(records), records, Window, NoWindowExcuses);

        Assert.True(classification.Straddles);
        Assert.Equal(RunVerdict.Complete, classification.Verdict);
    }

    /// <summary>The redelivery is forgiven, not hidden: the ledger says which dispatch it was.</summary>
    [Fact]
    public void TheSupersededAttemptIsNamedOnTheLedger()
    {
        var ledger = Ledger(WithAbandonedAttempt(AbandonedStepId));

        var attempt = Assert.Single(ledger.Superseded);

        Assert.Equal(AbandonedStepId, attempt.StepId);
        Assert.Equal(2, attempt.Starts);
        Assert.Equal(1, attempt.Returns);
        Assert.Equal(1, ledger.SupersededCount);
    }

    /// <summary>
    /// How far into the author's own code the abandoned attempt got before its replica went away is
    /// not knowable from the records and is not an invariant, so I6 must accept either an author
    /// record for it or none. Both fixtures here are the same incident, differing only in whether the
    /// replica survived long enough to write one line.
    /// </summary>
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void TheAbandonedAttemptMayOrMayNotHaveReachedTheAuthor(bool reachedTheAuthor)
    {
        var records = WithAbandonedAttempt(AbandonedStepId, reachedTheAuthor);

        var ledger = Ledger(records);

        Assert.DoesNotContain(ledger.Breaches, b => b.Invariant == "I6");
        Assert.True(ledger.IsComplete);
    }

    /// <summary>
    /// The discriminator, and the reason the forgiveness is not simply "starts may exceed returns".
    /// A dispatch that started and never returned at all was not redelivered -- nothing finished it --
    /// and that is the loss the whole suite exists to detect. It supersedes nothing and breaches the
    /// hop that counts returns.
    /// </summary>
    [Fact]
    public void AStepThatStartedAndNeverReturnedIsStillALostStep()
    {
        var records = Drop(CompleteRun, Templates.StepReturned, AbandonedStepId);

        var ledger = Ledger(records);

        Assert.Empty(ledger.Superseded);
        Assert.Contains(ledger.Breaches, b => b.Invariant == "I2");
    }

    /// <summary>
    /// The other half of the discriminator. A dispatch executed twice where BOTH attempts ran to
    /// completion is real double-processing, not a redelivery of an abandoned attempt: nothing was
    /// superseded, and an execution more than the dispatches sent is exactly what I1 is for.
    /// </summary>
    [Fact]
    public void ADispatchThatExecutedTwiceAndReturnedTwiceStillBreachesTheDispatchHop()
    {
        var records = CompleteRun
            .Concat(
            [
                Clone(CompleteRun, Templates.RunningTheStep, AbandonedStepId),
                Clone(CompleteRun, Templates.StepReturned, AbandonedStepId),
            ])
            .ToList();

        var ledger = Ledger(records);

        Assert.Empty(ledger.Superseded);
        Assert.Contains(ledger.Breaches, b => b.Invariant == "I1");
    }

    /// <summary>
    /// Why the pairing keys on both ids. The seeded workflow's terminal step is reached from two
    /// predecessors, so it runs twice in one fire under one step id and two separately minted entry
    /// keys. Keyed on the step id alone those two dispatches would merge, and losing one of them would
    /// read as the other one's redelivery -- a genuine lost step forgiven. Keyed on the pair they stay
    /// apart, and the loss stays a loss.
    /// </summary>
    [Fact]
    public void LosingOneEntryOfATwiceEnteredStepIsNotTheOtherOnesRedelivery()
    {
        var records = Drop(CompleteRun, Templates.StepReturned, TwiceEnteredStepId);

        var ledger = Ledger(records);

        Assert.Empty(ledger.Superseded);
        Assert.Contains(ledger.Breaches, b => b.Invariant == "I2");
    }

    /// <summary>The captured run carries no redelivery, and must not acquire one by this reading.</summary>
    [Fact]
    public void TheCapturedRunSupersedesNothing()
    {
        var ledger = Ledger(CompleteRun);

        Assert.Empty(ledger.Superseded);
        Assert.Equal(0, ledger.SupersededCount);
        Assert.True(ledger.IsComplete);
    }

    /// <summary>
    /// The projection carries the two ids the pairing needs. Read off the fixture rather than asserted
    /// in the abstract, so a drift in the attribute names breaks here rather than by quietly collapsing
    /// every dispatch into one null-keyed group in a five-minute soak.
    /// </summary>
    [Fact]
    public void EveryStepHopNamesItsDispatch()
    {
        var hops = CompleteRun
            .Where(r => r.Template is Templates.RunningTheStep or Templates.StepReturned)
            .ToList();

        // Twenty-two hops over eleven dispatches, each start with its own return: the source step,
        // whose scope omits the entry id because it has no input key, plus ten carrying both ids.
        Assert.Equal(22, hops.Count);
        Assert.Equal(11, hops.Select(r => (r.StepId, r.EntryId)).Distinct().Count());
        Assert.Single(hops.Where(r => r.EntryId is null).Select(r => r.StepId).Distinct());
    }

    private static RunLedger Ledger(IReadOnlyCollection<LogRecord> records) =>
        RunLedger.From(CompleteRun[0].CorrelationId!, records, WorkflowShape.SingleLineageCapture);

    /// <summary>
    /// The captured run plus one attempt at <paramref name="stepId"/> that started and never returned
    /// -- the replica taken away mid-execution, whose delivery the broker then handed to the survivor
    /// that produced the records already in the fixture.
    /// </summary>
    private static List<LogRecord> WithAbandonedAttempt(string stepId, bool reachedTheAuthor = false)
    {
        var records = CompleteRun.ToList();
        records.Add(Clone(CompleteRun, Templates.RunningTheStep, stepId));

        if (reachedTheAuthor)
        {
            records.Add(Clone(CompleteRun, Templates.AuthorConfig, stepId));
        }

        return records;
    }

    /// <summary>
    /// Copies the fixture's own record for a template and step, so the graft carries the real ids
    /// rather than ones invented here. Timestamped a second earlier: the abandoned attempt is the one
    /// that ran first.
    /// </summary>
    private static LogRecord Clone(IReadOnlyList<LogRecord> records, string template, string stepId)
    {
        var original = Find(records, template, stepId);

        return original with { Timestamp = original.Timestamp - TimeSpan.FromSeconds(1) };
    }

    private static List<LogRecord> Drop(
        IReadOnlyList<LogRecord> records, string template, string stepId)
    {
        var doomed = Find(records, template, stepId);

        return records.Where(r => !ReferenceEquals(r, doomed)).ToList();
    }

    private static LogRecord Find(IReadOnlyList<LogRecord> records, string template, string stepId)
    {
        var found = records.FirstOrDefault(r => r.Template == template && r.StepId == stepId);

        Assert.True(found is not null, $"the fixture carries no '{template}' record for step {stepId}");

        return found!;
    }

    private static IReadOnlyList<LogRecord> LoadFixture()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Resilience", "Fixtures", "complete-run.json");
        using var document = JsonDocument.Parse(File.ReadAllText(path));

        return document.RootElement.EnumerateArray().Select(LogRecord.FromSource).ToList();
    }
}
