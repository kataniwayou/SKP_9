using Processor.Analyst;
using Processor.Analyst.Loop;
using Processor.Analyst.Model;
using Processor.Analyst.Panels;
using Processor.Analyst.Tools;
using Xunit;

namespace BaseApi.Tests.Analyst;

public sealed class HistoryReadTests
{
    private static readonly TimeRange Window = new(
        new DateTimeOffset(2026, 10, 3, 7, 10, 0, TimeSpan.Zero), new DateTimeOffset(2026, 10, 3, 7, 25, 0, TimeSpan.Zero));
    private static readonly DateTimeOffset Limit = new(2026, 10, 2, 12, 51, 47, TimeSpan.Zero);

    [Fact]
    public void NoFromReadsTheWindow()
        => Assert.Equal(Window, InvestigationLoop.ClampHistory(Window, Limit, null));

    [Fact]
    public void AFromBeforeTheLimitIsClampedToTheLimit()
        => Assert.Equal(new TimeRange(Limit, Window.To),
            InvestigationLoop.ClampHistory(Window, Limit, Limit.AddDays(-3)));

    [Fact]
    public void AFromInsideTheRunIsKept()
    {
        var from = new DateTimeOffset(2026, 10, 3, 6, 0, 0, TimeSpan.Zero);
        Assert.Equal(new TimeRange(from, Window.To), InvestigationLoop.ClampHistory(Window, Limit, from));
    }

    [Fact]
    public void AFromAtOrAfterTheWindowEndReadsTheWindow()
        => Assert.Equal(Window, InvestigationLoop.ClampHistory(Window, Limit, Window.To.AddHours(1)));

    [Fact]
    public void WithNoLimitThereIsNoHistory()
        => Assert.Equal(Window, InvestigationLoop.ClampHistory(Window, null, Limit));

    [Fact]
    public void AHistoryRangeUsesAtMostFortyEightPrometheusPoints()
    {
        var range = new TimeRange(Limit, Window.To);
        var step = PrometheusPanelSource.ComputeStep(range, history: true);

        Assert.True(range.To - range.From <= step * PrometheusPanelSource.HistoryPoints);
    }

    [Fact]
    public void ReadPanelOffersAnOptionalFrom()
    {
        var spec = ToolCatalog.Build([new PanelDescriptor("step-outcomes", "business", "d")])
            .Single(t => t.Name == ToolNames.ReadPanel);

        Assert.Contains("\"from\":{\"type\":\"string\",\"format\":\"date-time\"}", spec.InputSchemaJson.Replace(" ", ""), StringComparison.Ordinal);
        Assert.Contains("\"required\":[\"panelId\"]", spec.InputSchemaJson.Replace(" ", ""), StringComparison.Ordinal);
    }

    [Fact]
    public async Task AHistoryReadIsServedTheClampedRangeAndTraced()
    {
        var reader = new FixturePanelReader().Reading("step-outcomes", "business", "{}", samples: 5);
        var model = new ScriptedModel(
            ModelReply.Of(ScriptedModel.Call(ToolNamesForTest.ReadPanel, new { panelId = "step-outcomes", from = "2026-09-01T00:00:00Z" })),
            ModelReply.Of(ScriptedModel.Call("report_no_finding", new { reason = "x" })));

        await Assert.ThrowsAnyAsync<Exception>(() => new InvestigationLoop(model, reader, TimeProvider.System,
                Microsoft.Extensions.Logging.Abstractions.NullLogger<InvestigationLoop>.Instance)
            .RunAsync("sys", new AnalystConfig(Guid.NewGuid(), 15, "p", ["step-outcomes"], 12, 100_000, 300),
                Window, "h", CancellationToken.None, historyLimit: Limit));

        var (range, history) = Assert.Single(reader.Requests);
        Assert.Equal(new TimeRange(Limit, Window.To), range);
        Assert.True(history);
    }
}
