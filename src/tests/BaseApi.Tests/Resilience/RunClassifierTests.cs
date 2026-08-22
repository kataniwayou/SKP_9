using BaseApi.Tests.Live.Resilience;
using Xunit;

namespace BaseApi.Tests.Resilience;

/// <summary>
/// Where "no lost steps" becomes a sentence a test can fail on. A short ledger is forgiven only
/// when the run met the fault AND something on that run says why; everything else is loss.
/// </summary>
public sealed class RunClassifierTests
{
    private static readonly DateTimeOffset T0 = new(2026, 8, 22, 12, 0, 0, TimeSpan.Zero);

    /// <summary>The schedule the soak actually runs: inject the fault at +150s, heal observed at +220s.</summary>
    private static readonly FaultWindow Window =
        new(T0 + TimeSpan.FromSeconds(150), T0 + TimeSpan.FromSeconds(220));

    /// <summary>
    /// A run that begins inside the outage. Run() spans its start plus five seconds, so starting
    /// here puts the whole run between FaultAt and HealedAt with margin at both ends -- deliberately
    /// not flush against either edge, so a change to the helper's span cannot silently turn a
    /// straddling fixture into a clear-of-window one and pass for the wrong reason.
    /// </summary>
    private static readonly DateTimeOffset StraddlingStart = T0 + TimeSpan.FromSeconds(155);

    [Fact]
    public void ACompleteRunIsComplete()
    {
        var records = Run(T0, complete: true);

        var classification = RunClassifier.Classify(Ledger(records), records, Window);

        Assert.Equal(RunVerdict.Complete, classification.Verdict);
    }

    /// <summary>
    /// Obligation 1 of the spec: a run that never met the fault has no excuse, and an excuse record
    /// on it does not buy one. Zero tolerance outside the window is what stops a scenario passing
    /// because the pipeline was quietly broken the whole time.
    /// </summary>
    [Fact]
    public void AShortRunClearOfTheWindowIsUnaccountedEvenWithAnExcuse()
    {
        var records = Run(T0, complete: false, excuse: Templates.StoreUnreachable);

        var classification = RunClassifier.Classify(Ledger(records), records, Window);

        Assert.False(classification.Straddles);
        Assert.Equal(RunVerdict.Unaccounted, classification.Verdict);
    }

    [Fact]
    public void AShortRunStraddlingTheWindowWithAnExcuseIsAccounted()
    {
        var records = Run(StraddlingStart, complete: false,
            excuse: Templates.StoreUnreachable);

        var classification = RunClassifier.Classify(Ledger(records), records, Window);

        Assert.True(classification.Straddles);
        Assert.Equal(RunVerdict.Accounted, classification.Verdict);
        Assert.Contains(Templates.StoreUnreachable, classification.Excuses);
    }

    [Fact]
    public void AShortRunStraddlingTheWindowWithNoExcuseIsUnaccounted()
    {
        var records = Run(StraddlingStart, complete: false);

        var classification = RunClassifier.Classify(Ledger(records), records, Window);

        Assert.True(classification.Straddles);
        Assert.Equal(RunVerdict.Unaccounted, classification.Verdict);
        Assert.Empty(classification.Excuses);
    }

    /// <summary>A Failed or Cancelled outcome is a run that ended and said so, not a run that vanished.</summary>
    [Theory]
    [InlineData("Failed")]
    [InlineData("Cancelled")]
    public void ANonCompletedOutcomeInTheWindowIsAnExcuse(string result)
    {
        var records = Run(StraddlingStart, complete: false)
            .Append(Record(StraddlingStart + TimeSpan.FromSeconds(5), Templates.EntryStepCompleted, result))
            .ToList();

        var classification = RunClassifier.Classify(Ledger(records), records, Window);

        Assert.Equal(RunVerdict.Accounted, classification.Verdict);
    }

    [Fact]
    public void ACompletedOutcomeIsNotAnExcuse()
    {
        var records = Run(StraddlingStart, complete: false)
            .Append(Record(StraddlingStart + TimeSpan.FromSeconds(5), Templates.EntryStepCompleted, "Completed"))
            .ToList();

        var classification = RunClassifier.Classify(Ledger(records), records, Window);

        Assert.Equal(RunVerdict.Unaccounted, classification.Verdict);
    }

    /// <summary>With no fault scheduled nothing straddles, so every short run is loss.</summary>
    [Fact]
    public void UnderNoFaultAShortRunIsAlwaysUnaccounted()
    {
        var records = Run(T0, complete: false, excuse: Templates.StoreUnreachable);

        var classification = RunClassifier.Classify(Ledger(records), records, FaultWindow.None);

        Assert.False(classification.Straddles);
        Assert.Equal(RunVerdict.Unaccounted, classification.Verdict);
    }

    private static RunLedger Ledger(IReadOnlyCollection<LogRecord> records) =>
        RunLedger.From("run", records, WorkflowShape.V8FanoutProof);

    /// <summary>
    /// A synthetic run over five seconds. Complete emits the canonical histogram; incomplete drops
    /// the last dispatch's downstream records, which is what an outage in flight looks like.
    /// </summary>
    private static List<LogRecord> Run(DateTimeOffset start, bool complete, string? excuse = null)
    {
        var steps = complete ? 11 : 10;
        var records = new List<LogRecord>
        {
            Record(start, Templates.EntryDispatched),
        };

        for (var i = 0; i < 10; i++)
        {
            records.Add(Record(start.AddSeconds(1), Templates.HandoffDispatched));
            records.Add(Record(start.AddSeconds(1), Templates.HandedOff));
        }

        for (var i = 0; i < 9; i++)
        {
            records.Add(Record(start.AddSeconds(2), Templates.AdvancedSuccessors));
        }

        for (var i = 0; i < steps; i++)
        {
            records.Add(Record(start.AddSeconds(3), Templates.RunningTheStep));
            records.Add(Record(start.AddSeconds(3), Templates.AuthorConfig));
            records.Add(Record(start.AddSeconds(4), Templates.StepReturned));
            records.Add(Record(start.AddSeconds(4), Templates.BranchCompleted));
        }

        records.Add(Record(start.AddSeconds(5), Templates.EntryStepCompleted, "Completed"));
        records.Add(Record(start.AddSeconds(5), Templates.TerminalCompleted, "Completed"));
        records.Add(Record(start.AddSeconds(5), Templates.TerminalCompleted, "Completed"));

        if (excuse is not null)
        {
            records.Add(Record(start.AddSeconds(4), excuse));
        }

        return records;
    }

    private static LogRecord Record(DateTimeOffset at, string template, string? result = null) =>
        new(at, template, Body: template, CorrelationId: "run", Result: result,
            Service: "orchestrator", Scope: "test");
}
