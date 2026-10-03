using System.Text.RegularExpressions;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging.Abstractions;
using Processor.Analyst;
using Processor.Analyst.Bit;
using Processor.Analyst.Graph;
using Processor.Analyst.Loop;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Analyst;

/// <summary>
/// The dynamic half of the model's understanding: the target's running graph, read from L2 by the
/// processor and rendered with the routing already applied. Pinned against the real graph captured with
/// the busy-mixed-feed window, whose routing is known: a good record forks after the normalizer, a
/// failure anywhere goes to record-outcome and then export-outcome, and a cancellation ends in place.
/// </summary>
public sealed class RunningGraphTests
{
    private static readonly RunningGraph Captured = ReplayFixtures.Graph("busy-mixed-feed");

    /// <summary>The label the renderer gave the step whose name starts with <paramref name="name"/>.</summary>
    private static string LabelOf(string rendered, string name)
        => Regex.Match(rendered, $@"^  (S\d+) {Regex.Escape(name)}", RegexOptions.Multiline).Groups[1].Value;

    private static string RouteOf(string rendered, string label)
        => Regex.Match(rendered, $@"^  {label}: (.*)$", RegexOptions.Multiline).Groups[1].Value.TrimEnd('\r');

    [Fact]
    public void TheEntryStepIsS1AndFailuresAnywhereGoToRecordOutcome()
    {
        var text = GraphRenderer.Render(GraphBriefing.Of(Captured));
        var recordOutcome = LabelOf(text, "record-outcome");

        Assert.Equal("S1", LabelOf(text, "split-importer"));
        Assert.Equal(
            $"Completed -> {LabelOf(text, "split-filefetcher")} | Failed -> {recordOutcome} | Cancelled -> branch ends",
            RouteOf(text, "S1"));

        // Every processing step routes Failed to record-outcome, which is entered on Failed only.
        foreach (var step in new[] { "split-filefetcher", "split-archiveexpander", "sk-normalizer-sample" })
        {
            Assert.Contains($"Failed -> {recordOutcome}", RouteOf(text, LabelOf(text, step)));
        }
    }

    [Fact]
    public void AGoodRecordForksAfterTheNormalizerAndAFailureEndsAfterExportOutcome()
    {
        var text = GraphRenderer.Render(GraphBriefing.Of(Captured));

        var normalizer = RouteOf(text, LabelOf(text, "sk-normalizer-sample"));
        Assert.StartsWith(
            $"Completed -> {LabelOf(text, "split-archivecollapser")}, {LabelOf(text, "sk-normalizer-alphabeta")}",
            normalizer);
        Assert.EndsWith("Cancelled -> branch ends", normalizer);

        Assert.StartsWith(
            $"Completed -> {LabelOf(text, "export-outcome")}", RouteOf(text, LabelOf(text, "record-outcome")));
        Assert.Equal(
            "Completed -> branch ends | Failed -> branch ends | Cancelled -> branch ends",
            RouteOf(text, LabelOf(text, "export-outcome")));
    }

    [Fact]
    public void TheBriefingCarriesNamesScheduleAndLiveness()
    {
        var text = GraphRenderer.Render(GraphBriefing.Of(Captured));

        // Kept beside the test output for a human to read what the model is shown.
        Directory.CreateDirectory(Path.Combine(AppContext.BaseDirectory, "TestResults"));
        File.WriteAllText(Path.Combine(AppContext.BaseDirectory, "TestResults", "running-graph-briefing.txt"), text);

        Assert.Contains("filefetcher-archiveexpander-chain_1.0.0", text, StringComparison.Ordinal);
        Assert.Contains("started (in the live set)", text, StringComparison.Ordinal);
        Assert.Contains("cron \"0 * * * * *\"", text, StringComparison.Ordinal);
        Assert.Contains("runs processor kafka-importer_2.2.0", text, StringComparison.Ordinal);
        Assert.DoesNotContain("can never run", text, StringComparison.Ordinal);
    }

    [Fact]
    public void AnUnenterableStepIsCalledOut()
    {
        var orphan = new StepL1(Guid.NewGuid(), 0, Guid.NewGuid(), "{}", []);
        var graph = Captured with
        {
            Steps = [.. Captured.Steps.Select(s => s.StepId == Captured.EntryStepIds[0]
                ? s with { NextStepIds = [.. s.NextStepIds, orphan.StepId] }
                : s), orphan],
        };

        Assert.Contains("can never run", GraphRenderer.Render(GraphBriefing.Of(graph)), StringComparison.Ordinal);
    }

    [Fact]
    public void AMissingGraphSaysWhyAndForbidsGuessingItsShape()
    {
        var text = GraphRenderer.Render(GraphBriefing.Missing("it is not started"));

        Assert.Contains("NOT available: it is not started", text, StringComparison.Ordinal);
        Assert.Contains("treat anything that depends on the graph's shape as unknown", text, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(4, StepResult.Failed, true)]
    [InlineData(4, StepResult.Cancelled, true)]
    [InlineData(1, StepResult.Completed, true)]
    [InlineData(1, StepResult.Failed, false)]
    [InlineData(0, StepResult.Completed, false)]
    public void TheAdvancementRuleIsTheFrameworks(int condition, StepResult result, bool accepted)
        => Assert.Equal(accepted, GraphRenderer.Accepts(condition, result));

    // ── the L2 source ──────────────────────────────────────────────────────────────────────────────

    private static async Task<InMemoryL2> L2With(string? store, bool live)
    {
        var l2 = new InMemoryL2();
        var wf = Captured.WorkflowId;

        if (store is not null)
        {
            await l2.Db.HashSetAsync(L2ProjectionKeys.Workflow(wf), L2ProjectionKeys.StoreField, store,
                When.Always, CommandFlags.None);
        }

        if (live)
        {
            await l2.Db.SetAddAsync(L2ProjectionKeys.Live(), wf.ToString("D"));
        }

        return l2;
    }

    private static string StoreJson() => System.Text.Json.JsonSerializer.Serialize(
        new WorkflowStoreProjection([.. Captured.EntryStepIds], Captured.Cron, [.. Captured.Steps]),
        MessagingJson.Options);

    [Fact]
    public async Task TheSourceReadsTheProjectionTheStartWrote()
    {
        var l2 = await L2With(StoreJson(), live: true);

        var briefing = await new L2WorkflowGraphSource(l2.Multiplexer).ReadAsync(Captured.WorkflowId, CancellationToken.None);

        Assert.NotNull(briefing.Graph);
        Assert.True(briefing.Graph.Live);
        Assert.Equal(Captured.Steps.Count, briefing.Graph.Steps.Count);
        Assert.Equal("0 * * * * *", briefing.Graph.Cron);
    }

    [Fact]
    public async Task AWorkflowThatIsNotStartedHasNoGraphAndSaysSo()
    {
        var l2 = await L2With(store: null, live: false);

        var briefing = await new L2WorkflowGraphSource(l2.Multiplexer).ReadAsync(Captured.WorkflowId, CancellationToken.None);

        Assert.Null(briefing.Graph);
        Assert.Contains("not started", briefing.Unavailable, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnUnreadableProjectionIsMissingNotAFailure()
    {
        var l2 = await L2With("{not json", live: true);

        var briefing = await new L2WorkflowGraphSource(l2.Multiplexer).ReadAsync(Captured.WorkflowId, CancellationToken.None);

        Assert.Null(briefing.Graph);
        Assert.Contains("could not be read", briefing.Unavailable, StringComparison.Ordinal);
    }

    // ── the processor and the contract ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task TheRunningGraphRidesInTheFirstMessageNotTheSystemPrompt()
    {
        // A model with no script answers nothing; the first turn it was sent is all this test needs.
        var model = new ScriptedModel();
        var processor = new AnalystProcessor(
            new PreflightBit(model, new BitCache(new InMemorySharedState(), "m"),
                options: Microsoft.Extensions.Options.Options.Create(new AnalystBitOptions { Mode = BitMode.StructureOnly })),
            new InvestigationLoop(model, new FixturePanelReader(), TimeProvider.System, NullLogger<InvestigationLoop>.Instance),
            NullLogger<AnalystProcessor>.Instance,
            graphs: new FixedGraphSource(GraphBriefing.Of(Captured)));

        await Assert.ThrowsAnyAsync<Exception>(() => processor.AnalyseAsync(new AnalystConfig(
            Captured.WorkflowId, 15, StagedPrompt, ["step-outcomes"], 12, 100_000, 300), CancellationToken.None));

        var first = Assert.Single(model.Received);
        Assert.Contains("<running-graph>", first.Transcript[0].Text!, StringComparison.Ordinal);
        Assert.DoesNotContain("<running-graph>", first.System, StringComparison.Ordinal);
    }

    [Fact]
    public void TheContractCarriesTheFrameworkPrimer()
    {
        var system = ContractPrompt.Compose("guidance");

        Assert.Contains(ContractPrompt.FrameworkPrimer, system, StringComparison.Ordinal);
        Assert.Contains("SECONDS first", system, StringComparison.Ordinal);
        Assert.Contains("has no step", system, StringComparison.Ordinal);
    }

    internal static readonly string StagedPrompt = string.Join("\n\n",
        "Preamble.",
        "STAGE 1 - RESEARCH. " + new string('x', 100),
        "STAGE 2 - VALIDATE. " + new string('x', 100),
        "STAGE 3 - PLAN. " + new string('x', 100),
        "STAGE 4 - EXECUTE. " + new string('x', 100),
        "STAGE 5 - VERIFY. " + new string('x', 100));
}
