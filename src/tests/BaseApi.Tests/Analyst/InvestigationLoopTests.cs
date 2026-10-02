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

    // Stages()/SubmitFinding()/Submit() now live on AnalystScript, shared with AnalystProcessorTests.

    [Fact]
    public async Task ATerminalSubmitFindingProducesAFinding()
    {
        var model = new ScriptedModel([.. AnalystScript.Stages(), AnalystScript.Submit()]);

        var outcome = await Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None);

        var finding = Assert.IsType<LoopOutcome.Finding>(outcome);
        Assert.Equal("Drifting", finding.Value.Verdict);
        Assert.Equal(Hash, finding.Value.PromptHash);
    }

    [Fact]
    public async Task ATerminalReportNoFindingProducesNoFinding()
    {
        // C1: report_no_finding is checked for stage PRESENCE only (not the full cross-reference
        // suite -- there is genuinely no finding to cross-reference), so the five stages still have
        // to be recorded before this terminates quietly.
        var model = new ScriptedModel(
            [
                .. AnalystScript.Stages(),
                ModelReply.Of(ScriptedModel.Call(ToolNamesForTest.ReportNoFinding, new { reason = "nothing moved" })),
            ]);

        var outcome = await Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None);

        var none = Assert.IsType<LoopOutcome.NoFinding>(outcome);
        Assert.Equal("nothing moved", none.Reason);

        // It still carries a publishable document: Quiet, the reason, no insight, and the same
        // facts about the run a finding carries.
        Assert.Equal("Quiet", none.Value.Verdict);
        Assert.Equal("nothing moved", none.Value.Reason);
        Assert.Empty(none.Value.Insights);
        Assert.Equal(Guid.Parse("11111111-1111-1111-1111-111111111111"), none.Value.Target.WorkflowId);
        Assert.Equal(["queue-depth", "arrival-mean"], none.Value.Trace.Select(t => t.PanelId).ToArray());
        Assert.Equal(182, none.Value.Window.SamplesExamined);
    }

    [Fact]
    public async Task FabricatedStagesWithNoPanelReadsCannotBuySilenceViaReportNoFinding()
    {
        // F1: CheckStagesRecorded is presence-only and never consulted InvestigationTrace, so five
        // invented stage calls followed by report_no_finding used to pass -- Cancelled, silence --
        // from a run where read_panel was never called once. The record_* schemas require only
        // non-empty strings; nothing about them requires having actually observed anything. This is
        // the worst failure the design calls out: a monitor reporting all-clear because it never ran.
        var model = new ScriptedModel(
            [
                .. AnalystScript.StagesWithoutReadingAnyPanel(),
                .. Persisting(ModelReply.Of(ScriptedModel.Call(ToolNamesForTest.ReportNoFinding, new { reason = "nothing moved" }))),
            ]);

        var ex = await Assert.ThrowsAsync<AnalysisImpossibleException>(
            () => Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None));

        Assert.Contains("no panel was ever read", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task AnUnbelievableWindowIsInconclusiveBecauseAConclusionNeverFailsTheStep()
    {
        // The step result reports whether the facilities worked, never what the model concluded. The
        // panel answered; judging its answer unbelievable is a conclusion, so the run ends as an
        // Inconclusive document -- carrying the reason -- rather than failing the step.
        var model = new ScriptedModel(
            ModelReply.Of(ScriptedModel.Call(ToolNamesForTest.ReadPanel, new { panelId = "queue-depth" })),
            ModelReply.Of(ScriptedModel.Call("record_validation", new
            {
                analysable = false,
                concerns = new[] { "queue-depth covers only part of the window" },
                reason = "partial coverage; cannot tell no-data from no-problem",
            })));

        var outcome = await Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None);

        var quiet = Assert.IsType<LoopOutcome.NoFinding>(outcome);
        Assert.Contains("partial coverage", quiet.Reason, StringComparison.Ordinal);
        Assert.Equal("Inconclusive", quiet.Value.Verdict);
        Assert.Contains("partial coverage", quiet.Value.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnUnbelievableVerdictWithNothingReadFails()
    {
        // "Unbelievable" must rest on evidence the sources returned. With no panel read there is no
        // evidence to judge, so this is not a conclusion but an invalid result, and it fails.
        var model = new ScriptedModel(
            ModelReply.Of(ScriptedModel.Call("record_validation", new
            {
                analysable = false,
                concerns = new[] { "nothing looked at" },
                reason = "cannot see",
            })));

        var ex = await Assert.ThrowsAsync<AnalysisImpossibleException>(
            () => Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None));

        Assert.Contains("before reading any panel", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheFindingCarriesItsTargetInsightsAndUsageAgainstTheBudget()
    {
        var model = new ScriptedModel([.. AnalystScript.Stages(), AnalystScript.Submit()]);

        var outcome = await Loop(model).RunAsync(
            "sys", Config(maxIterations: 20, maxTokens: 100_000, wallClock: 300), Window, Hash, CancellationToken.None);

        var finding = Assert.IsType<LoopOutcome.Finding>(outcome).Value;
        Assert.Equal(Guid.Parse("11111111-1111-1111-1111-111111111111"), finding.Target.WorkflowId);
        Assert.Equal(["queue-depth", "arrival-mean"], Assert.Single(finding.Insights).Panels);
        Assert.Equal(AnalystScript.Stages().Length + 1, finding.Usage.Calls);
        Assert.Equal(new FindingBudget(20, 100_000, 300), finding.Usage.Budget);
        Assert.Null(finding.Usage.Dispatch);
    }

    [Fact]
    public async Task AnInsightCorrelatingAnUnreadPanelIsNotExported()
    {
        // The insight is the part an operator acts on; one built on a panel never read is fabricated.
        var fabricated = ScriptedModel.Call(ToolNamesForTest.SubmitFinding, new
        {
            verdict = "Notable",
            insights = new[]
            {
                new { claim = "c", why = "w", panels = new[] { "queue-depth", "never-read" } },
            },
            samplesExamined = 91,
            evidence = new[] { new { panelId = "queue-depth", layer = "ops", label = "max", value = "4" } },
            ruledOut = new[]
            {
                new { hypothesis = "broker slow", disconfirmingCriterion = "queue depth over 100", whatWasSeen = "max 4" },
            },
        });

        var model = new ScriptedModel([.. AnalystScript.Stages(), .. Persisting(ModelReply.Of(fabricated))]);

        var ex = await Assert.ThrowsAsync<AnalysisImpossibleException>(
            () => Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None));

        Assert.Contains("never-read", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AModelCallThatHangsPastTheWallClockFailsRatherThanWedging()
    {
        // F5: BudgetLedger's deadline was only ever checked BETWEEN turns (BeginTurn); production
        // passes CancellationToken.None straight into model.SendAsync with no adapter-level
        // timeout, so a single hung call would wedge the pod's one consumer forever while liveness
        // -- "the loops still turning" -- kept passing. HangingModel simulates that: it advances the
        // fake clock past the deadline WHILE the call is still in flight, then waits on its own `ct`
        // -- the deadline-linked token InvestigationLoop now derives and passes down.
        var clock = new FakeTimeProvider();
        var model = new HangingModel(clock, TimeSpan.FromSeconds(300));

        // ThrowsAnyAsync, not ThrowsAsync: Task.Delay(..., ct) throws TaskCanceledException, a
        // subclass of OperationCanceledException -- AnalystProcessor's catch filters on the base
        // type, so the subclass is exactly what production sees too.
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => Loop(model, clock: clock).RunAsync("sys", Config(wallClock: 300), Window, Hash, CancellationToken.None));
    }

    [Fact]
    public async Task AStagelessReportNoFindingIsImpossibleNotQuiet()
    {
        // C1: the design's worst failure is a monitor that reports all-clear because it never ran.
        // report_no_finding on turn one, with zero stages recorded, is exactly that shape -- and
        // must fail loudly rather than cancel silently.
        var model = new ScriptedModel(
            [.. Persisting(ModelReply.Of(ScriptedModel.Call(ToolNamesForTest.ReportNoFinding, new { reason = "nothing moved" })))]);

        var ex = await Assert.ThrowsAsync<AnalysisImpossibleException>(
            () => Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None));

        Assert.Contains("report_no_finding", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheTraceIsAssembledFromWhatWasActuallyRead()
    {
        // Ground truth, not a model claim. This is what lets a reader tell "checked the ops layer
        // and it was clean" from "never looked". Stages("arrival-mean") reads arrival-mean and then
        // its corroborating panel, queue-depth, which is what the default submit cites.
        var model = new ScriptedModel(
            [
                .. AnalystScript.Stages("arrival-mean"),
                AnalystScript.Submit(),
            ]);

        var outcome = await Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None);

        var finding = Assert.IsType<LoopOutcome.Finding>(outcome);
        Assert.Equal([1, 2], finding.Value.Trace.Select(t => t.Ordinal).ToArray());
        Assert.Equal(["arrival-mean", "queue-depth"], finding.Value.Trace.Select(t => t.PanelId).ToArray());
    }

    [Fact]
    public async Task AllToolResultsForOneReplyComeBackInASingleUserTurn()
    {
        // Splitting parallel results across several user turns silently trains the model to stop
        // making parallel calls at all. AnalystScript.Stages() precede this reply only so the eventual
        // submit_finding satisfies Task 9's cross-reference assertions; each of their record_* calls
        // is answered with its own one-result turn, so instead of asserting there is only ever one
        // user-turn-with-results in the whole run (no longer true once stages exist), this isolates
        // the turn that carries MORE THAN ONE result -- there can be only one such turn, and it must
        // be the one produced by this reply's two parallel calls.
        //
        // Note: ScriptedModel.Received stores the loop's transcript list by reference, not a snapshot
        // per call, so every entry reflects the final transcript once the run completes -- any index
        // works equally well here.
        var model = new ScriptedModel(
            [
                .. AnalystScript.Stages(),
                new ModelReply(
                    [
                        ScriptedModel.Call(ToolNamesForTest.ReadPanel, new { panelId = "arrival-mean" }),
                        ScriptedModel.Call(ToolNamesForTest.ReadPanel, new { panelId = "queue-depth" }),
                    ],
                    Text: null, InputTokens: 0, OutputTokens: 0),
                AnalystScript.Submit(),
            ]);

        await Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None);

        var transcript = model.Received[^1].Transcript;
        var turnsWithMultipleResults = transcript.Where(t => t.ToolResults.Count > 1).ToArray();

        var combined = Assert.Single(turnsWithMultipleResults);
        Assert.Equal(ModelRole.User, combined.Role);
        Assert.Equal(2, combined.ToolResults.Count);
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
        // No server-side schema enforcement may ever be load-bearing above the seam, regardless of
        // what the backend happens to enforce, so a malformed input is an expected event. Hand it
        // back as an error result and let the model correct itself; only a loop that never recovers
        // becomes a failed step. AnalystScript.Stages() precede the malformed call only
        // so the eventual submit_finding satisfies Task 9's cross-reference assertions; their record_*
        // calls always validate, so filtering the whole run's results down to the errors still finds
        // exactly the one this test causes (Received aliases the loop's own transcript list, so it
        // reflects the final state regardless of which index is read).
        var model = new ScriptedModel(
            [
                .. AnalystScript.Stages(),
                ModelReply.Of(ScriptedModel.Call(ToolNamesForTest.ReadPanel, new { wrongField = "x" })),
                AnalystScript.Submit(),
            ]);

        var outcome = await Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None);

        Assert.IsType<LoopOutcome.Finding>(outcome);
        var errors = model.Received[^1].Transcript.SelectMany(t => t.ToolResults).Where(r => r.IsError).ToArray();
        Assert.True(Assert.Single(errors).IsError);
    }

    [Fact]
    public async Task AReplyWithNoToolCallsAtAllIsImpossible()
    {
        // The model talked instead of acting. Nothing was executed, so there is nothing to report and
        // no way to continue honestly. Note this cannot be caused by disabled thinking on this
        // backend -- K3 always thinks and cannot be configured otherwise -- so a reply with no tool
        // calls is a genuine anomaly.
        var model = new ScriptedModel(new ModelReply([], Text: "I think it is fine", 0, 0));

        await Assert.ThrowsAsync<AnalysisImpossibleException>(
            () => Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None));
    }

    [Fact]
    public async Task AReplyWithNoToolCallsSaysWhatTheModelWroteAndWhyItStopped()
    {
        // Without this the failure is undiagnosable: the reply is discarded, and "no tool calls"
        // cannot tell a conclusion written as prose from a reply cut off at a length limit.
        var model = new ScriptedModel(new ModelReply([], Text: "The window is quiet.\nNothing to report.", 0, 0)
        {
            FinishReason = "stop",
        });

        var ex = await Assert.ThrowsAsync<AnalysisImpossibleException>(
            () => Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None));

        Assert.Contains("finish_reason 'stop'", ex.Message, StringComparison.Ordinal);
        Assert.Contains("\"The window is quiet. Nothing to report.\"", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ALongNoToolReplyIsTruncatedInTheMessage()
    {
        var model = new ScriptedModel(new ModelReply([], Text: new string('x', 2000), 0, 0));

        var ex = await Assert.ThrowsAsync<AnalysisImpossibleException>(
            () => Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None));

        Assert.Contains("(truncated from 2000)", ex.Message, StringComparison.Ordinal);
        Assert.Contains("finish_reason (none)", ex.Message, StringComparison.Ordinal);
        Assert.True(ex.Message.Length < 800);
    }

    [Fact]
    public async Task ACallToAToolThatDoesNotExistIsReturnedAsAToolErrorNotAnException()
    {
        // ToolCatalog.SchemaFor has no case for a name the model invented; resolving the schema from
        // the catalog the loop already holds means an unknown name is a handled tool_result, not an
        // ArgumentOutOfRangeException the model gets no chance to correct. AnalystScript.Stages() run afterward only
        // to satisfy Task 9's cross-reference assertions on the eventual valid submit_finding; their
        // record_* calls always validate, so filtering the whole run down to error results still
        // isolates exactly the one this test causes.
        var model = new ScriptedModel(
            [
                ModelReply.Of(ScriptedModel.Call("not_a_real_tool", new { })),
                .. AnalystScript.Stages(),
                AnalystScript.Submit(),
            ]);

        var outcome = await Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None);

        Assert.IsType<LoopOutcome.Finding>(outcome);
        var errors = model.Received[^1].Transcript.SelectMany(t => t.ToolResults).Where(r => r.IsError).ToArray();
        Assert.True(Assert.Single(errors).IsError);
    }

    [Fact]
    public async Task TwoTerminalCallsInOneReplyIsImpossibleNotResolvedByPosition()
    {
        // C1: report_no_finding then submit_finding in the same reply is self-contradicting. Picking
        // the first by list position would make the same two calls export a finding in one order and
        // report silence -- the all-clear -- in the other. Neither is honest; only a failure is.
        // This never reaches the stage assertions -- the two-terminal-calls check runs before any
        // tool is executed -- so no stages are needed.
        var model = new ScriptedModel(
            new ModelReply(
                [
                    ScriptedModel.Call(ToolNamesForTest.ReportNoFinding, new { reason = "nothing moved" }),
                    AnalystScript.SubmitFinding(),
                ],
                Text: null, InputTokens: 0, OutputTokens: 0));

        var ex = await Assert.ThrowsAsync<AnalysisImpossibleException>(
            () => Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None));

        Assert.Contains(ToolNamesForTest.ReportNoFinding, ex.Message, StringComparison.Ordinal);
        Assert.Contains(ToolNamesForTest.SubmitFinding, ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnInvalidSubmitFindingIsAnErrorResultNotAnExportedDocument()
    {
        // C2: "Quiet" is not in submit_finding's verdict enum, and AnalystFinding's own contract says
        // a verdict must never reach a document unvalidated. Terminate is reached only after the same
        // client-side validation every other call gets, so this comes back as an error tool_result
        // the model can correct, not a persisted document and not a raw exception. AnalystScript.Stages() run
        // between the invalid attempt and the valid one only to satisfy Task 9's assertions on the
        // eventual successful submit_finding; their record_* calls always validate, so filtering the
        // whole run's results down to the errors still isolates exactly the one this test causes.
        var invalidFinding = ScriptedModel.Call(ToolNamesForTest.SubmitFinding, new
        {
            verdict = "Quiet",
            insights = new[] { new { claim = "c", why = "w", panels = new[] { "arrival-mean", "queue-depth" } } },
            samplesExamined = 10,
            evidence = new[] { new { panelId = "arrival-mean", layer = "ops", label = "mean", value = "1ms" } },
            ruledOut = Array.Empty<object>(),
        });

        var model = new ScriptedModel(
            [
                ModelReply.Of(invalidFinding),
                .. AnalystScript.Stages(),
                AnalystScript.Submit(),
            ]);

        var outcome = await Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None);

        var finding = Assert.IsType<LoopOutcome.Finding>(outcome);
        Assert.Equal("Drifting", finding.Value.Verdict);
        var errors = model.Received[^1].Transcript.SelectMany(t => t.ToolResults).Where(r => r.IsError).ToArray();
        Assert.True(Assert.Single(errors).IsError);
    }

    [Fact]
    public async Task AReportNoFindingMissingItsReasonIsAnErrorResultNotACancel()
    {
        // C2, the other terminal tool: a missing required property must not throw a raw
        // KeyNotFoundException out of RunAsync on a path the brief calls an expected event, and must
        // not silently cancel with no reason recorded anywhere. AnalystScript.Stages() run between the invalid
        // attempt and the valid submit only to satisfy Task 9's assertions; their record_* calls
        // always validate, so filtering the whole run's results down to the errors still isolates
        // exactly the one this test causes.
        var model = new ScriptedModel(
            [
                ModelReply.Of(ScriptedModel.Call(ToolNamesForTest.ReportNoFinding, new { })),
                .. AnalystScript.Stages(),
                AnalystScript.Submit(),
            ]);

        var outcome = await Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None);

        Assert.IsType<LoopOutcome.Finding>(outcome);
        var errors = model.Received[^1].Transcript.SelectMany(t => t.ToolResults).Where(r => r.IsError).ToArray();
        Assert.True(Assert.Single(errors).IsError);
    }

    [Fact]
    public async Task ATerminalCallThatCrossesTheTokenCeilingInTheSameReplyStillProducesAFinding()
    {
        // I1: usage for this reply is recorded before the terminal call is handled. The finding
        // exists and has already been paid for, so the budget must not discard it just because the
        // same reply also crossed the ceiling -- exhaustion means "no answer", and here there is one.
        var model = new ScriptedModel(
            [
                .. AnalystScript.Stages(),
                new ModelReply([AnalystScript.SubmitFinding()], Text: null, InputTokens: 60_000, OutputTokens: 60_000),
            ]);

        var outcome = await Loop(model).RunAsync(
            "sys", Config(maxTokens: 100_000), Window, Hash, CancellationToken.None);

        Assert.IsType<LoopOutcome.Finding>(outcome);
    }

    [Fact]
    public async Task DataReturnedIsFalseWhenThePanelAnsweredWithNoSamples()
    {
        // I2: DataReturned is the field that distinguishes "looked at the ops layer and saw nothing"
        // from "never looked" -- the trace's entire reason for existing. AnalystScript.Stages("arrival-mean") is
        // the ONLY read of arrival-mean in this run (the other read is its corroborating panel), so
        // the single matching entry is the one this test is about.
        var panels = Panels().MissingSeries("arrival-mean");
        var model = new ScriptedModel([.. AnalystScript.Stages("arrival-mean"), AnalystScript.Submit("arrival-mean")]);

        var outcome = await Loop(model, panels).RunAsync("sys", Config(), Window, Hash, CancellationToken.None);

        var finding = Assert.IsType<LoopOutcome.Finding>(outcome);
        var entry = Assert.Single(finding.Value.Trace, t => t.PanelId == "arrival-mean");
        Assert.False(entry.DataReturned);
    }

    [Fact]
    public async Task ANonTerminalCallAlongsideAValidTerminalCallInTheSameReplyLeavesNoTraceEntry()
    {
        // I3: the run ended on submit_finding in this same reply, so the read_panel call that arrived
        // beside it was never executed. Pinning this down so a future refactor that executes tools
        // before checking for a terminal cannot quietly add a phantom trace entry for a read that
        // never happened.
        //
        // Task 9's assertions require submit_finding's own evidence to cite a panel that was
        // genuinely read, so this run can no longer end with an EMPTY trace the way the original
        // version of this test did -- AnalystScript.Stages() legitimately reads "queue-depth" beforehand, which is
        // what submit_finding now cites, and then its corroborating panel. The invariant under test
        // is unchanged: the read that arrives alongside the terminal call must never reach the
        // trace, so the trace holds exactly the two reads the stages made.
        var model = new ScriptedModel(
            [
                .. AnalystScript.Stages(),
                new ModelReply(
                    [
                        ScriptedModel.Call(ToolNamesForTest.ReadPanel, new { panelId = "queue-depth" }),
                        AnalystScript.SubmitFinding(),
                    ],
                    Text: null, InputTokens: 0, OutputTokens: 0),
            ]);

        var outcome = await Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None);

        var finding = Assert.IsType<LoopOutcome.Finding>(outcome);
        Assert.Equal(["queue-depth", "arrival-mean"], finding.Value.Trace.Select(t => t.PanelId).ToArray());
    }

    [Fact]
    public async Task AFindingWhoseEvidenceWasNeverReadIsImpossible()
    {
        // The end-to-end shape of the assertions: the loop, not a unit test, refuses it.
        var model = new ScriptedModel([.. AnalystScript.Stages(), .. Persisting(AnalystScript.Submit("never-read"))]);

        var ex = await Assert.ThrowsAsync<AnalysisImpossibleException>(
            () => Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None));

        Assert.Contains("never-read", ex.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// A model that repeats the same ungrounded terminal call past the cap: what the old "fails at
    /// once" tests now script, because a single rejection is handed back for correction.
    /// </summary>
    private static IEnumerable<ModelReply> Persisting(ModelReply terminal)
        => Enumerable.Repeat(terminal, InvestigationLoop.MaxRejections + 1);

    [Fact]
    public async Task ARejectedConclusionIsHandedBackAndCanBeCorrected()
    {
        // The busy-healthy replay failure: Quiet declared with a planned panel never read. The
        // rejection goes back as the call's error result, the model reads the panel and re-verifies,
        // and the second report_no_finding is grounded.
        var noFinding = ModelReply.Of(ScriptedModel.Call(ToolNamesForTest.ReportNoFinding, new { reason = "nothing moved" }));
        var model = new ScriptedModel(
            [
                .. AnalystScript.StagesWithoutReadingAnyPanel(),
                noFinding,
                ModelReply.Of(ScriptedModel.Call(ToolNamesForTest.ReadPanel, new { panelId = "queue-depth" })),
                ModelReply.Of(ScriptedModel.Call("record_readings", new { readings = new[] { new { panelId = "queue-depth", summary = "max 4", trusted = true } } })),
                ModelReply.Of(ScriptedModel.Call("record_verification", new { verdicts = new[] { new { hypothesis = "broker slow", survived = false, whatWasSeen = "max 4", citedPanels = new[] { "queue-depth" } } } })),
                noFinding,
            ]);

        var outcome = await Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None);

        Assert.IsType<LoopOutcome.NoFinding>(outcome);
        var handedBack = model.Received[6].Transcript[^1].ToolResults.Single();
        Assert.True(handedBack.IsError);
        Assert.Contains("REJECTED, nothing was published", handedBack.Content, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ARuledOutCriterionIsTheOneThePlanStatedNotTheModelsRewording()
    {
        // Two stall replays failed on a reworded criterion with a sound conclusion. The planned
        // words are published instead, which is exactly what the check exists to guarantee.
        var reworded = ScriptedModel.Call(ToolNamesForTest.SubmitFinding, new
        {
            verdict = "Drifting",
            insights = new[] { new { claim = "c", why = "w", panels = new[] { "queue-depth", "arrival-mean" } } },
            samplesExamined = 91,
            evidence = new[] { new { panelId = "queue-depth", layer = "ops", label = "mean", value = "180ms" } },
            ruledOut = new[] { new { hypothesis = "broker slow", disconfirmingCriterion = "depth above a hundred", whatWasSeen = "max 4" } },
        });
        var model = new ScriptedModel([.. AnalystScript.Stages(), ModelReply.Of(reworded)]);

        var outcome = await Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None);

        var finding = Assert.IsType<LoopOutcome.Finding>(outcome).Value;
        Assert.Equal("queue depth over 100", Assert.Single(finding.RuledOut).DisconfirmingCriterion);
    }

    [Fact]
    public async Task ARuledOutHypothesisThePlanNeverNamedStillFails()
    {
        // Filling criteria from the plan must not launder an invented hypothesis.
        var invented = ScriptedModel.Call(ToolNamesForTest.SubmitFinding, new
        {
            verdict = "Drifting",
            insights = new[] { new { claim = "c", why = "w", panels = new[] { "queue-depth", "arrival-mean" } } },
            samplesExamined = 91,
            evidence = new[] { new { panelId = "queue-depth", layer = "ops", label = "mean", value = "180ms" } },
            ruledOut = new[] { new { hypothesis = "made up later", disconfirmingCriterion = "x", whatWasSeen = "y" } },
        });
        var model = new ScriptedModel([.. AnalystScript.Stages(), .. Persisting(ModelReply.Of(invented))]);

        var ex = await Assert.ThrowsAsync<AnalysisImpossibleException>(
            () => Loop(model).RunAsync("sys", Config(), Window, Hash, CancellationToken.None));

        Assert.Contains("never proposed", ex.Message, StringComparison.Ordinal);
    }
}

// ToolNamesForTest now lives on AnalystScript.cs, shared with AnalystProcessorTests.

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

/// <summary>
/// F5: a model whose call never completes on its own -- it advances the fake clock past the wall
/// clock deadline WHILE the call is in flight (simulating a live call that takes long enough for the
/// deadline to elapse mid-flight), then awaits its own cancellation token forever. Proves the loop's
/// deadline-linked token, not just BudgetLedger's between-turn check, is what actually bounds a single
/// hung call.
/// </summary>
internal sealed class HangingModel(FakeTimeProvider clock, TimeSpan wallClock) : IAnalystModel
{
    public async Task<ModelReply> SendAsync(
        string system, IReadOnlyList<ModelTurn> transcript, IReadOnlyList<ToolSpec> tools, CancellationToken ct)
    {
        clock.Advance(wallClock + TimeSpan.FromSeconds(1));
        await Task.Delay(Timeout.InfiniteTimeSpan, ct).ConfigureAwait(false);
        throw new InvalidOperationException("unreachable: the delay above must have observed cancellation");
    }
}
