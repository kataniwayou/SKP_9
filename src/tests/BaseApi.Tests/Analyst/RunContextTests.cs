using Microsoft.Extensions.Logging.Abstractions;
using Processor.Analyst;
using Processor.Analyst.Bit;
using Processor.Analyst.Graph;
using Processor.Analyst.Loop;
using Processor.Analyst.Panels;
using BaseApi.Tests.Support;
using Xunit;

namespace BaseApi.Tests.Analyst;

internal sealed class FixedRunContextSource(RunContext ctx) : IRunContextSource
{
    public Task<RunContext> ReadAsync(Guid workflowId, DateTimeOffset now, CancellationToken ct) => Task.FromResult(ctx);
}

internal sealed class ThrowingRunContextSource(Func<Exception> fault) : IRunContextSource
{
    public Task<RunContext> ReadAsync(Guid workflowId, DateTimeOffset now, CancellationToken ct) => Task.FromException<RunContext>(fault());
}

public sealed class RunContextTests
{
    private static readonly TimeRange Window = new(
        new DateTimeOffset(2026, 10, 3, 7, 10, 0, TimeSpan.Zero), new DateTimeOffset(2026, 10, 3, 7, 25, 0, TimeSpan.Zero));

    private static readonly RunContext Chain = new(
        DateTimeOffset.Parse("2026-10-02T12:51:47Z"), DateTimeOffset.Parse("2026-10-02T12:51:47Z"),
        [new(DateTimeOffset.Parse("2026-10-02T14:14:00Z"), 2), new(DateTimeOffset.Parse("2026-10-02T22:43:00Z"), 3)], null);

    [Fact]
    public void TheBlockStatesTheLimitAndTheDeploys()
    {
        var text = RunContextRenderer.Render(Chain, Window);

        Assert.StartsWith("<run-context>", text, StringComparison.Ordinal);
        Assert.Contains("Window under judgement: 2026-10-03T07:10:00Z to 2026-10-03T07:25:00Z.", text, StringComparison.Ordinal);
        Assert.Contains("History available back to 2026-10-02T12:51:47Z", text, StringComparison.Ordinal);
        Assert.Contains("14:14Z (2026-10-02), 22:43Z (2026-10-02)", text, StringComparison.Ordinal);
        Assert.EndsWith("</run-context>", text, StringComparison.Ordinal);
    }

    [Fact]
    public void AMissingContextSaysHistoryIsUnavailableAndWhy()
    {
        var text = RunContextRenderer.Render(RunContext.Missing("no start record"), Window);

        Assert.Contains("History is NOT available: no start record.", text, StringComparison.Ordinal);
        Assert.Contains("Judge the window alone.", text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheRunContextRidesInTheFirstMessage()
    {
        var model = new ScriptedModel();
        var processor = new AnalystProcessor(
            new PreflightBit(model, new BitCache(new InMemorySharedState(), "m"),
                options: Microsoft.Extensions.Options.Options.Create(new AnalystBitOptions { Mode = BitMode.StructureOnly })),
            new InvestigationLoop(model, new FixturePanelReader(), TimeProvider.System, NullLogger<InvestigationLoop>.Instance),
            NullLogger<AnalystProcessor>.Instance,
            runs: new FixedRunContextSource(Chain));

        await Assert.ThrowsAnyAsync<Exception>(() => processor.AnalyseAsync(new AnalystConfig(
            Guid.NewGuid(), 15, RunningGraphTests.StagedPrompt, ["step-outcomes"], 12, 100_000, 300), CancellationToken.None));

        Assert.Contains("<run-context>", Assert.Single(model.Received).Transcript[0].Text!, StringComparison.Ordinal);
    }

    private static (AnalystProcessor Processor, ScriptedModel Model, RecordingLogger<AnalystProcessor> Log) WithRuns(IRunContextSource runs)
    {
        var model = new ScriptedModel();
        var log = new RecordingLogger<AnalystProcessor>();
        var processor = new AnalystProcessor(
            new PreflightBit(model, new BitCache(new InMemorySharedState(), "m"),
                options: Microsoft.Extensions.Options.Options.Create(new AnalystBitOptions { Mode = BitMode.StructureOnly })),
            new InvestigationLoop(model, new FixturePanelReader(), TimeProvider.System, NullLogger<InvestigationLoop>.Instance),
            log,
            runs: runs);
        return (processor, model, log);
    }

    [Fact]
    public async Task AThrowingRunContextSourceDegradesToHistoryUnavailable()
    {
        // Spec 4.1: history is optional. A run-context source that throws (here a malformed date)
        // must cost the dispatch its history, not the dispatch itself.
        var (processor, model, log) = WithRuns(new ThrowingRunContextSource(() => new FormatException("bad date")));

        // The scripted model has no replies, so the loop fails after its first turn -- which is
        // proof the dispatch got past the run context to the model.
        await Assert.ThrowsAnyAsync<Exception>(() => processor.AnalyseAsync(new AnalystConfig(
            Guid.NewGuid(), 15, RunningGraphTests.StagedPrompt, ["step-outcomes"], 12, 100_000, 300), CancellationToken.None));

        var first = Assert.Single(model.Received).Transcript[0].Text!;
        Assert.Contains("History is NOT available: the run context could not be read: bad date.", first, StringComparison.Ordinal);
        Assert.Single(log.Records, r => r.Level == Microsoft.Extensions.Logging.LogLevel.Warning && r.Exception is FormatException);
    }

    [Fact]
    public async Task ACancelledDispatchIsNotDegraded()
    {
        // Cancelled while the run context is being read: the dispatch stops, it does not carry on
        // without history.
        using var cts = new CancellationTokenSource();
        var (processor, model, _) = WithRuns(new ThrowingRunContextSource(() =>
        {
            cts.Cancel();
            return new OperationCanceledException(cts.Token);
        }));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => processor.AnalyseAsync(new AnalystConfig(
            Guid.NewGuid(), 15, RunningGraphTests.StagedPrompt, ["step-outcomes"], 12, 100_000, 300), cts.Token));

        Assert.Empty(model.Received);
    }

    [Fact]
    public void DeclaredExpectationsAreStatedForDataOutcomesOnly()
    {
        var text = RunContextRenderer.Render(Chain, Window,
            new AnalystExpectations(0.65, 0.25, "dev endless feed: 3 of every 5 files are built to fail"));

        Assert.Contains("Declared expectations (data-domain outcomes only; system problems are never covered): "
            + "failed share up to 0.65, cancelled share up to 0.25 -- dev endless feed: 3 of every 5 files are built to fail.",
            text, StringComparison.Ordinal);
    }

    [Fact]
    public void ADeclaredShareRendersWithoutLosingItsThirdDecimal()
    {
        var text = RunContextRenderer.Render(Chain, Window, new AnalystExpectations(0.655, null, "feed."));

        Assert.Contains("failed share up to 0.655 -- feed.", text, StringComparison.Ordinal);
        Assert.DoesNotContain("feed..", text, StringComparison.Ordinal);
    }

    [Fact]
    public void WithoutExpectationsEveryDeterministicProblemIsReported()
        => Assert.Contains("No declared expectations: report every deterministic problem.",
            RunContextRenderer.Render(Chain, Window), StringComparison.Ordinal);
}
