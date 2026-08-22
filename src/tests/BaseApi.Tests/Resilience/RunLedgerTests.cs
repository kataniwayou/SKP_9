using System.Text.Json;
using BaseApi.Tests.Live.Resilience;
using Xunit;

namespace BaseApi.Tests.Resilience;

/// <summary>
/// The oracle, exercised against a real captured run and against that run with one record taken
/// away. Each removal names the hop it breaks, which is the property the scenarios rely on: a
/// breach is a diagnosis, not a boolean.
/// </summary>
public sealed class RunLedgerTests
{
    private static readonly IReadOnlyList<LogRecord> CompleteRun = LoadFixture();

    [Fact]
    public void TheCapturedRunIsSeventySevenRecords()
    {
        Assert.Equal(77, CompleteRun.Count);
    }

    [Fact]
    public void TheCapturedRunSatisfiesEveryInvariant()
    {
        var ledger = RunLedger.From(
            CompleteRun[0].CorrelationId!, CompleteRun, WorkflowShape.V8FanoutProof);

        Assert.Empty(ledger.Breaches);
        Assert.True(ledger.IsComplete);
    }

    [Fact]
    public void TheLedgerCountsTheCanonicalHistogram()
    {
        var ledger = RunLedger.From(
            CompleteRun[0].CorrelationId!, CompleteRun, WorkflowShape.V8FanoutProof);

        Assert.Equal(1, ledger.Count(Templates.EntryDispatched));
        Assert.Equal(10, ledger.Count(Templates.HandoffDispatched));
        Assert.Equal(11, ledger.Count(Templates.RunningTheStep));
        Assert.Equal(11, ledger.Count(Templates.AuthorConfig));
        Assert.Equal(11, ledger.Count(Templates.StepReturned));
        Assert.Equal(11, ledger.Count(Templates.BranchCompleted));
        Assert.Equal(1, ledger.Count(Templates.EntryStepCompleted));
        Assert.Equal(10, ledger.Count(Templates.HandedOff));
        Assert.Equal(9, ledger.Count(Templates.AdvancedSuccessors));
        Assert.Equal(2, ledger.Count(Templates.TerminalCompleted));
    }

    [Theory]
    [InlineData(Templates.RunningTheStep, "I1")]
    [InlineData(Templates.StepReturned, "I2")]
    [InlineData(Templates.BranchCompleted, "I3")]
    [InlineData(Templates.HandedOff, "I4")]
    [InlineData(Templates.AuthorConfig, "I6")]
    public void DroppingOneRecordBreachesTheInvariantThatNamesItsHop(string template, string invariant)
    {
        var maimed = DropOne(CompleteRun, template);

        var ledger = RunLedger.From(
            CompleteRun[0].CorrelationId!, maimed, WorkflowShape.V8FanoutProof);

        Assert.Contains(ledger.Breaches, b => b.Invariant == invariant);
    }

    [Fact]
    public void DroppingAHandoffDispatchBreachesBothTheHopAndTheGraphWalk()
    {
        var maimed = DropOne(CompleteRun, Templates.HandoffDispatched);

        var ledger = RunLedger.From(
            CompleteRun[0].CorrelationId!, maimed, WorkflowShape.V8FanoutProof);

        Assert.Contains(ledger.Breaches, b => b.Invariant == "I1");
        Assert.Contains(ledger.Breaches, b => b.Invariant == "I4");
        Assert.Contains(ledger.Breaches, b => b.Invariant == "I5");
    }

    [Fact]
    public void DroppingATerminalBreachesTheGraphWalkOnly()
    {
        var maimed = DropOne(CompleteRun, Templates.TerminalCompleted);

        var ledger = RunLedger.From(
            CompleteRun[0].CorrelationId!, maimed, WorkflowShape.V8FanoutProof);

        Assert.Contains(ledger.Breaches, b => b.Invariant == "I5");
        Assert.DoesNotContain(ledger.Breaches, b => b.Invariant == "I1");
    }

    /// <summary>
    /// The discriminator that keeps log loss from reading as step loss. An author record without
    /// its framework twin is not a lost step, and I6 is the only invariant that must notice.
    /// </summary>
    [Fact]
    public void LosingOnlyTheAuthorRecordIsNotAStepLoss()
    {
        var maimed = DropOne(CompleteRun, Templates.AuthorConfig);

        var ledger = RunLedger.From(
            CompleteRun[0].CorrelationId!, maimed, WorkflowShape.V8FanoutProof);

        Assert.Equal(new[] { "I6" }, ledger.Breaches.Select(b => b.Invariant).ToArray());
    }

    [Fact]
    public void TheLedgerSpansTheRunsFirstAndLastRecord()
    {
        var ledger = RunLedger.From(
            CompleteRun[0].CorrelationId!, CompleteRun, WorkflowShape.V8FanoutProof);

        Assert.Equal(CompleteRun.Min(r => r.Timestamp), ledger.StartedAt);
        Assert.Equal(CompleteRun.Max(r => r.Timestamp), ledger.EndedAt);
    }

    private static IReadOnlyList<LogRecord> DropOne(IReadOnlyList<LogRecord> records, string template)
    {
        var index = records.ToList().FindIndex(r => r.Template == template);
        Assert.True(index >= 0, $"the fixture carries no record for template '{template}'");

        return records.Where((_, i) => i != index).ToList();
    }

    /// <summary>
    /// Reads the captured run through the same projection the live reader uses, so a change to the
    /// field names breaks here — hermetically — rather than in a five-minute scenario.
    /// </summary>
    private static IReadOnlyList<LogRecord> LoadFixture()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Resilience", "Fixtures", "complete-run.json");
        using var document = JsonDocument.Parse(File.ReadAllText(path));

        return document.RootElement.EnumerateArray().Select(LogRecord.FromSource).ToList();
    }
}
