using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Processor.Analyst;
using Processor.Analyst.Loop;
using Processor.Analyst.Model;
using Processor.Analyst.Panels;
using Xunit;

namespace BaseApi.Tests.Analyst;

public sealed class InvestigationLoopTests
{
    private static readonly TimeRange Window = new(
        new DateTimeOffset(2026, 9, 24, 0, 0, 0, TimeSpan.Zero),
        new DateTimeOffset(2026, 9, 24, 6, 0, 0, TimeSpan.Zero));

    private const string Hash = "abc123";

    private static AnalystConfig Config(int maxIterations = 20, int maxTokens = 100_000, int wallClock = 300)
        => new(
            TargetWorkflowId: Guid.Parse("11111111-1111-1111-1111-111111111111"),
            WindowMinutes: 360,
            Prompt: "look for drift",
            PanelSet: ["arrival-mean", "queue-depth"],
            MaxIterations: maxIterations,
            MaxTokens: maxTokens,
            WallClockSeconds: wallClock);

    private static FixturePanelReader Panels()
        => new FixturePanelReader()
            .Reading("arrival-mean", "ops", """{"mean":180}""", samples: 91)
            .Reading("queue-depth", "ops", """{"max":4}""", samples: 91);

    private static InvestigationLoop Loop(IAnalystModel model, IPanelReader? panels = null, FakeTimeProvider? clock = null)
        => new(model, panels ?? Panels(), clock ?? new FakeTimeProvider(), NullLogger<InvestigationLoop>.Instance);

    private static ModelToolCall SubmitFinding() => ScriptedModel.Call(ToolNamesForTest.SubmitFinding, new
    {
        verdict = "Drifting",
        narrative = "arrival mean rose",
        samplesExamined = 91,
        evidence = new[] { new { panelId = "arrival-mean", layer = "ops", label = "mean", value = "180ms" } },
        ruledOut = new[]
        {
            new { hypothesis = "broker slow", disconfirmingCriterion = "queue depth over 100", whatWasSeen = "max 4" },
        },
    });

    [Fact]
    public async Task ATerminalSubmitFindingProducesAFinding()
    {
        var model = new ScriptedModel(ModelReply.Of(SubmitFinding()));

        var outcome = await Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None);

        var finding = Assert.IsType<LoopOutcome.Finding>(outcome);
        Assert.Equal("Drifting", finding.Value.Verdict);
        Assert.Equal(Hash, finding.Value.PromptHash);
    }

    [Fact]
    public async Task ATerminalReportNoFindingProducesNoFinding()
    {
        var model = new ScriptedModel(
            ModelReply.Of(ScriptedModel.Call(ToolNamesForTest.ReportNoFinding, new { reason = "nothing moved" })));

        var outcome = await Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None);

        var none = Assert.IsType<LoopOutcome.NoFinding>(outcome);
        Assert.Equal("nothing moved", none.Reason);
    }

    [Fact]
    public async Task TheTraceIsAssembledFromWhatWasActuallyRead()
    {
        // Ground truth, not a model claim. This is what lets a reader tell "checked the ops layer
        // and it was clean" from "never looked".
        var model = new ScriptedModel(
            ModelReply.Of(ScriptedModel.Call(ToolNamesForTest.ReadPanel, new { panelId = "arrival-mean" })),
            ModelReply.Of(ScriptedModel.Call(ToolNamesForTest.ReadPanel, new { panelId = "queue-depth" })),
            ModelReply.Of(SubmitFinding()));

        var outcome = await Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None);

        var finding = Assert.IsType<LoopOutcome.Finding>(outcome);
        Assert.Equal([1, 2], finding.Value.Trace.Select(t => t.Ordinal).ToArray());
        Assert.Equal(["arrival-mean", "queue-depth"], finding.Value.Trace.Select(t => t.PanelId).ToArray());
    }

    [Fact]
    public async Task AllToolResultsForOneReplyComeBackInASingleUserTurn()
    {
        // Splitting parallel results across several user turns silently trains the model to stop
        // making parallel calls at all.
        var model = new ScriptedModel(
            new ModelReply(
                [
                    ScriptedModel.Call(ToolNamesForTest.ReadPanel, new { panelId = "arrival-mean" }),
                    ScriptedModel.Call(ToolNamesForTest.ReadPanel, new { panelId = "queue-depth" }),
                ],
                Text: null, InputTokens: 0, OutputTokens: 0),
            ModelReply.Of(SubmitFinding()));

        await Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None);

        // The second call's transcript: assistant turn, then ONE user turn carrying both results.
        var transcript = model.Received[1].Transcript;
        var userTurns = transcript.Where(t => t.Role == ModelRole.User && t.ToolResults.Count > 0).ToArray();

        Assert.Single(userTurns);
        Assert.Equal(2, userTurns[0].ToolResults.Count);
    }

    [Fact]
    public async Task RunningOutOfIterationsWithNoTerminalCallIsImpossibleNotQuiet()
    {
        // The single most important negative case in the design: an analysis that did not finish is
        // an analysis that did not run. Reporting it as quiet would make silence -- the all-clear --
        // mean "the agent gave up".
        var model = new ScriptedModel(
            ModelReply.Of(ScriptedModel.Call(ToolNamesForTest.ReadPanel, new { panelId = "arrival-mean" })),
            ModelReply.Of(ScriptedModel.Call(ToolNamesForTest.ReadPanel, new { panelId = "queue-depth" })));

        var ex = await Assert.ThrowsAsync<AnalysisImpossibleException>(
            () => Loop(model).RunAsync("sys", Config(maxIterations: 2), Window, Hash, CancellationToken.None));

        Assert.Contains("iteration", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task RunningOutOfWallClockIsImpossible()
    {
        var clock = new FakeTimeProvider();
        var model = new AdvancingModel(clock, TimeSpan.FromSeconds(200));

        var ex = await Assert.ThrowsAsync<AnalysisImpossibleException>(
            () => Loop(model, clock: clock).RunAsync("sys", Config(wallClock: 300), Window, Hash, CancellationToken.None));

        Assert.Contains("wall clock", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task RunningOutOfTokensIsImpossible()
    {
        var model = new ScriptedModel(
            new ModelReply([ScriptedModel.Call(ToolNamesForTest.ReadPanel, new { panelId = "arrival-mean" })],
                Text: null, InputTokens: 60_000, OutputTokens: 60_000));

        var ex = await Assert.ThrowsAsync<AnalysisImpossibleException>(
            () => Loop(model).RunAsync("sys", Config(maxTokens: 100_000), Window, Hash, CancellationToken.None));

        Assert.Contains("token", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task AnUnreachablePanelIsImpossible()
    {
        // The source could not be read, so the analysis could not run. Not a sad reading.
        //
        // FixturePanelReader throws the same PanelUnavailableException type both for a panel
        // configured to fail AND for a panel the test simply never set up (see
        // FixturePanelReader.ReadAsync: "not configured in this fixture"). Asserting on the
        // exception type alone would pass identically for a typo'd panel id, so this asserts on
        // the specific failure reason ("elasticsearch timed out") that only the intentionally
        // failing panel produces.
        var panels = new FixturePanelReader().Failing("arrival-mean", "elasticsearch timed out");
        var model = new ScriptedModel(
            ModelReply.Of(ScriptedModel.Call(ToolNamesForTest.ReadPanel, new { panelId = "arrival-mean" })));

        var ex = await Assert.ThrowsAsync<AnalysisImpossibleException>(
            () => Loop(model, panels).RunAsync("sys", Config(), Window, Hash, CancellationToken.None));

        Assert.Contains("elasticsearch timed out", ex.Message, StringComparison.Ordinal);
        Assert.Contains("arrival-mean", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AToolInputThatFailsItsOwnSchemaIsReturnedAsAToolErrorNotAnExplosion()
    {
        // Server-side strict enforcement does not exist on the on-prem path, so a malformed input is
        // an expected event. Hand it back as an error result and let the model correct itself; only
        // a loop that never recovers becomes a failed step.
        var model = new ScriptedModel(
            ModelReply.Of(ScriptedModel.Call(ToolNamesForTest.ReadPanel, new { wrongField = "x" })),
            ModelReply.Of(SubmitFinding()));

        var outcome = await Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None);

        Assert.IsType<LoopOutcome.Finding>(outcome);
        var results = model.Received[1].Transcript.SelectMany(t => t.ToolResults).ToArray();
        Assert.True(results.Single().IsError);
    }

    [Fact]
    public async Task AReplyWithNoToolCallsAtAllIsImpossible()
    {
        // The model talked instead of acting. On Opus 5 with thinking disabled this is a known
        // failure shape -- a tool call written into visible text, never executed, nothing raised.
        // Thinking is left on precisely to avoid it, and this is the net underneath.
        var model = new ScriptedModel(new ModelReply([], Text: "I think it is fine", 0, 0));

        await Assert.ThrowsAsync<AnalysisImpossibleException>(
            () => Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None));
    }

    [Fact]
    public async Task ACallToAToolThatDoesNotExistIsReturnedAsAToolErrorNotAnException()
    {
        // ToolCatalog.SchemaFor has no case for a name the model invented; resolving the schema from
        // the catalog the loop already holds means an unknown name is a handled tool_result, not an
        // ArgumentOutOfRangeException the model gets no chance to correct.
        var model = new ScriptedModel(
            ModelReply.Of(ScriptedModel.Call("not_a_real_tool", new { })),
            ModelReply.Of(SubmitFinding()));

        var outcome = await Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None);

        Assert.IsType<LoopOutcome.Finding>(outcome);
        var results = model.Received[1].Transcript.SelectMany(t => t.ToolResults).ToArray();
        Assert.True(results.Single().IsError);
    }
}

/// <summary>Mirrors ToolNames, which is internal to the processor and reached through InternalsVisibleTo.</summary>
internal static class ToolNamesForTest
{
    internal const string ReadPanel = "read_panel";
    internal const string SubmitFinding = "submit_finding";
    internal const string ReportNoFinding = "report_no_finding";
}

/// <summary>A model that burns wall clock on every turn and never terminates.</summary>
internal sealed class AdvancingModel(FakeTimeProvider clock, TimeSpan perTurn) : IAnalystModel
{
    public Task<ModelReply> SendAsync(
        string system, IReadOnlyList<ModelTurn> transcript, IReadOnlyList<ToolSpec> tools, CancellationToken ct)
    {
        clock.Advance(perTurn);
        return Task.FromResult(ModelReply.Of(ScriptedModel.Call(ToolNamesForTest.ReadPanel, new { panelId = "arrival-mean" })));
    }
}
