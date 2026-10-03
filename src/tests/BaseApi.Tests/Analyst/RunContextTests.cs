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
    public void WithoutExpectationsEveryDeterministicProblemIsReported()
        => Assert.Contains("No declared expectations: report every deterministic problem.",
            RunContextRenderer.Render(Chain, Window), StringComparison.Ordinal);
}
