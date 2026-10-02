using BaseConsole.Core.Naming;
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Processor.Analyst;
using Processor.Analyst.Bit;
using Processor.Analyst.Loop;
using Processor.Analyst.Model;
using Xunit;

namespace BaseApi.Tests.Analyst;

public sealed class AnalystProcessorTests
{
    // "queue-wait" is a real PanelRegistry id -- F3 makes AnalyseAsync validate PanelSet against the
    // registry before the loop runs, so a fictitious id like the old "queue-depth" would now fail
    // every test in this file at that check rather than reaching what each test actually means to
    // exercise.
    // Structurally valid, because PromptStructure now rejects a prompt with no stage headings before
    // the judge is ever called -- "look for drift" would short-circuit every test here at that check.
    internal static readonly string StagedPrompt = string.Join("\n\n",
        "Look for drift.",
        "STAGE 1 - RESEARCH. " + new string('x', 100),
        "STAGE 2 - VALIDATE. " + new string('x', 100),
        "STAGE 3 - PLAN. " + new string('x', 100),
        "STAGE 4 - EXECUTE. " + new string('x', 100),
        "STAGE 5 - VERIFY. " + new string('x', 100));

    private static AnalystConfig Config(string? prompt = null, int window = 360)
        => new(
            TargetWorkflowId: Guid.Parse("11111111-1111-1111-1111-111111111111"),
            WindowMinutes: window,
            Prompt: prompt ?? StagedPrompt,
            PanelSet: ["queue-wait", "step-outcomes"],
            MaxIterations: 20,
            MaxTokens: 100_000,
            WallClockSeconds: 300);

    private static AnalystProcessor Processor(
        IAnalystModel bitModel,
        IAnalystModel loopModel,
        FakeTimeProvider? clock = null,
        TokenMeter? meter = null,
        IEntityNameSource? names = null)
        => new(
            new PreflightBit(bitModel, new BitCache(new BaseApi.Tests.Support.InMemorySharedState(), "test-model/high")),
            new InvestigationLoop(loopModel, new FixturePanelReader()
                    .Reading("queue-wait", "ops", """{"max":4}""", samples: 91)
                    .Reading("step-outcomes", "business", """{"Completed":12}""", samples: 12),
                clock ?? new FakeTimeProvider(), NullLogger<InvestigationLoop>.Instance),
            NullLogger<AnalystProcessor>.Instance,
            meter,
            names);

    private static ModelReply FitBit() => ModelReply.Of(
        ScriptedModel.Call("report_fitness", new { problems = Array.Empty<object>() }));

    [Fact]
    public async Task AConfigWithNoPromptFails()
    {
        // The schema guarantees the field is present; it cannot guarantee it survived trimming.
        var processor = Processor(new ScriptedModel(FitBit(), FitBit(), FitBit()), new ScriptedModel());

        await Assert.ThrowsAsync<FailedException>(
            () => processor.AnalyseAsync(Config(prompt: "   "), CancellationToken.None));
    }

    [Fact]
    public async Task AWindowLongerThanTheRetentionFails()
    {
        // A well-formed config the processor cannot work with is still an analysis that could not run.
        var processor = Processor(new ScriptedModel(FitBit(), FitBit(), FitBit()), new ScriptedModel());

        await Assert.ThrowsAsync<FailedException>(
            () => processor.AnalyseAsync(Config(window: 60 * 24 * 400), CancellationToken.None));
    }

    [Fact]
    public async Task AMaxTokensBudgetLargerThanTheCompiledCeilingFails()
    {
        // Same shape as AWindowLongerThanTheRetentionFails: a well-formed config the processor
        // cannot work with is still an analysis that could not run. MaxTokens has no ceiling of its
        // own -- a config row can set it to anything -- so AnalystProcessor.MaxTokenBudget is the
        // compiled ceiling that keeps a config edit from being the only thing standing between the
        // pod and its manifest memory limit.
        var processor = Processor(new ScriptedModel(FitBit(), FitBit(), FitBit()), new ScriptedModel());

        var config = Config() with { MaxTokens = 10_000_001 };

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => processor.AnalyseAsync(config, CancellationToken.None));

        Assert.Contains("MaxTokens", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task APanelSetNamingAnUnregisteredPanelFails()
    {
        // F3: panelSet is schema-checked for "an array of strings" only, so a payload can name a
        // panel id that does not exist in PanelRegistry. Before this check the first sign of that
        // was a raw ArgumentException out of LivePanelReader.Find on a live dispatch, caught by
        // nothing this processor declares and landing in the framework's generic fault branch --
        // "the transform faulted", stack trace and all -- instead of a clean failed step. This is
        // live today: AnalystConfigSchemaTests' own canonical "valid" payload used to name
        // "arrival-mean", which PanelRegistryTests explicitly asserts is NOT in the registry.
        var processor = Processor(new ScriptedModel(FitBit(), FitBit(), FitBit()), new ScriptedModel());

        var config = Config() with { PanelSet = ["queue-wait", "arrival-mean"] };

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => processor.AnalyseAsync(config, CancellationToken.None));

        Assert.Contains("arrival-mean", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AModelCallThatHangsPastTheWallClockFailsTheDispatch()
    {
        // F5: WallClockSeconds must bound the model call itself, not just the gap BETWEEN turns --
        // production passes CancellationToken.None with no adapter-level timeout, so without a
        // deadline-linked token a hung call would wedge the pod's one consumer forever while
        // liveness kept passing. The hang surfaces as OperationCanceledException with the outer `ct`
        // (CancellationToken.None here) un-cancelled, which AnalyseAsync's existing filtered catch
        // maps to FailedException -- the disposition falls out correctly with no special-casing.
        var clock = new FakeTimeProvider();
        var processor = Processor(new ScriptedModel(FitBit(), FitBit(), FitBit()), new HangingModel(clock, TimeSpan.FromSeconds(300)), clock);

        await Assert.ThrowsAsync<FailedException>(
            () => processor.AnalyseAsync(Config() with { WallClockSeconds = 300 }, CancellationToken.None));
    }

    [Fact]
    public async Task AnUnfitPromptFailsTheDispatch()
    {
        // Not Cancelled. An agent that just failed its fitness exam has analysed nothing, and
        // silence is the all-clear.
        var unfit = ModelReply.Of(ScriptedModel.Call("report_fitness", new
        {
            problems = new[] { new { stage = "verify", kind = "missing", offending = "…" } },
        }));
        var processor = Processor(
            new ScriptedModel(unfit, unfit, unfit, unfit, unfit), new ScriptedModel());

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => processor.AnalyseAsync(Config(), CancellationToken.None));

        Assert.Contains("verify", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnUnfitPromptReportsWhatTheJudgeObjectedTo()
    {
        // Stage and kind say WHICH stage is wrong; only the quote says why. Without it the single
        // actionable detail in a rejection had to be recovered by re-running the exam by hand and
        // hoping to draw the same verdict.
        var quoted = "Decide whether anything in this window deserves an operator's attention";
        var unfit = ModelReply.Of(ScriptedModel.Call("report_fitness", new
        {
            problems = new[] { new { stage = "plan", kind = "missing", offending = quoted } },
        }));
        var processor = Processor(
            new ScriptedModel(unfit, unfit, unfit, unfit, unfit), new ScriptedModel());

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => processor.AnalyseAsync(Config(), CancellationToken.None));

        Assert.Contains(quoted, ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AVerboseObjectionIsCappedRatherThanDominatingTheRecord()
    {
        var unfit = ModelReply.Of(ScriptedModel.Call("report_fitness", new
        {
            problems = new[]
            {
                new { stage = "plan", kind = "missing", offending = new string('q', 4000) },
            },
        }));
        var processor = Processor(
            new ScriptedModel(unfit, unfit, unfit, unfit, unfit), new ScriptedModel());

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => processor.AnalyseAsync(Config(), CancellationToken.None));

        Assert.Contains("truncated from 4000", ex.Message, StringComparison.Ordinal);
        Assert.True(ex.Message.Length < 1000, $"message was {ex.Message.Length} chars");
    }

    [Fact]
    public async Task ABitJudgeFailureFailsTheDispatch()
    {
        // Point 4: PreflightBit.CheckAsync itself throws AnalysisImpossibleException when the judge
        // answers without calling report_fitness -- a different call site from the loop's, for the
        // same "the analysis could not run" signal. AnalyseAsync's catch has to cover this call site
        // too, not just loop.RunAsync, or this escapes as a raw AnalysisImpossibleException instead
        // of the FailedException every other "could not run" path produces.
        var noToolCall = new ScriptedModel(
            ModelReply.Of(), ModelReply.Of(), ModelReply.Of(), ModelReply.Of(), ModelReply.Of());
        var processor = Processor(noToolCall, new ScriptedModel());

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => processor.AnalyseAsync(Config(), CancellationToken.None));

        // The quorum reports the spoiled election rather than any one ballot; the point of the
        // test is unchanged -- it arrives as FailedException, not a raw escape.
        Assert.Contains("usable verdict", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ACancelledRunFailsRatherThanReadingAsQuiet()
    {
        // Point 5: the worst failure this design can have is a monitor that reports all-clear
        // because it broke. Cancelled is reserved for a run that reached a terminal tool and found
        // nothing -- never for a run that was torn down or timed out before it got there. A bare
        // OperationCanceledException escaping AnalyseAsync unmapped would either read as a code bug
        // to the framework's generic fault branch, or -- if it were ever allowed to alias Cancelled
        // -- as silence, which downstream reads as the all-clear. CancellationToken.None here means
        // ct.IsCancellationRequested is false, so the `when (!ct.IsCancellationRequested)` filter on
        // AnalyseAsync's catch still applies -- this is "someone else's" cancellation, e.g. a
        // library's own timeout, which is exactly what that catch exists to map deliberately.
        var torndown = new ThrowingModel(new OperationCanceledException("connection torn down"));
        var processor = Processor(torndown, new ScriptedModel());

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => processor.AnalyseAsync(Config(), CancellationToken.None));

        Assert.Contains("cancel", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task ACancellationOfTheCallersOwnTokenEscapesRatherThanBeingReportedFailed()
    {
        // The OCE filter's reason to exist: ProcessDispatchHandler's catch (FailedException) sits
        // ABOVE its own filtered general catch, so if the token AnalyseAsync was handed is ever the
        // one that got cancelled, mapping that to FailedException here would acknowledge the
        // delivery with a fabricated outcome and lose the message. Letting it escape instead creates
        // no hazard: an uncaught OperationCanceledException parks the delivery with no StepOutcome
        // sent at all, so nothing downstream ever reads this as Cancelled -- or as anything.
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        var torndown = new ThrowingModel(new OperationCanceledException("shutting down"));
        var processor = Processor(torndown, new ScriptedModel());

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => processor.AnalyseAsync(Config(), cts.Token));
    }

    [Fact]
    public async Task AnAnalysisThatFindsNothingCompletesWithAQuietDocument()
    {
        // C1: report_no_finding still needs its five stages recorded -- the check is presence-only,
        // but it applies to this branch too now.
        var processor = Processor(
            new ScriptedModel(FitBit(), FitBit(), FitBit()),
            new ScriptedModel(
                [
                    .. AnalystScript.Stages("queue-wait"),
                    ModelReply.Of(ScriptedModel.Call("report_no_finding", new { reason = "nothing moved" })),
                ]));

        // No cancel any more: the run completes and its verdict is published, so a healthy window
        // reaches the topic as plainly as a finding does.
        var document = await processor.AnalyseAsync(Config(), CancellationToken.None);

        Assert.Equal("Quiet", document.Verdict);
        Assert.Equal("nothing moved", document.Reason);
    }

    [Fact]
    public async Task AStagelessReportNoFindingFailsRatherThanCancels()
    {
        // C1: a model that records zero stages and calls report_no_finding on turn one has analysed
        // nothing -- that must not read as the same quiet, all-clear disposition as a run that
        // actually reached verification and found nothing worth reporting.
        var processor = Processor(
            new ScriptedModel(FitBit(), FitBit(), FitBit()),
            new ScriptedModel([.. Enumerable.Repeat(ModelReply.Of(
                ScriptedModel.Call("report_no_finding", new { reason = "nothing moved" })),
                InvestigationLoop.MaxRejections + 1)]));

        await Assert.ThrowsAsync<FailedException>(
            () => processor.AnalyseAsync(Config(), CancellationToken.None));
    }

    [Fact]
    public async Task AnAnalysisThatCannotRunFails()
    {
        var processor = Processor(
            new ScriptedModel(FitBit(), FitBit(), FitBit()),
            new ScriptedModel(new ModelReply([], Text: "hmm", 0, 0)));

        await Assert.ThrowsAsync<FailedException>(
            () => processor.AnalyseAsync(Config(), CancellationToken.None));
    }

    [Fact]
    public async Task ThePromptHashOnTheFindingIsTheHashOfThePayloadPrompt()
    {
        // The one check that makes "edit payload -> restart workflow -> confirm it took" performable.
        var processor = Processor(new ScriptedModel(FitBit(), FitBit(), FitBit()), new ScriptedModel([.. AnalystScript.Stages("queue-wait"), AnalystScript.Submit("queue-wait")]));

        var finding = await processor.AnalyseAsync(Config(), CancellationToken.None);

        Assert.Equal(PromptHash.Of(StagedPrompt), finding.PromptHash);
    }

    [Fact]
    public async Task TheFindingNamesItsTargetFromL2()
    {
        var names = new StubNames(new Dictionary<Guid, string>
        {
            [Guid.Parse("11111111-1111-1111-1111-111111111111")] = "filefetcher-archiveexpander-chain",
        });
        var processor = Processor(
            new ScriptedModel(FitBit(), FitBit(), FitBit()),
            new ScriptedModel([.. AnalystScript.Stages("queue-wait"), AnalystScript.Submit("queue-wait")]),
            names: names);

        var finding = await processor.AnalyseAsync(Config(), CancellationToken.None);

        Assert.Equal("filefetcher-archiveexpander-chain", finding.Target.Name);
    }

    [Fact]
    public async Task AnUnreadableTargetNameNeverCostsTheFinding()
    {
        var processor = Processor(
            new ScriptedModel(FitBit(), FitBit(), FitBit()),
            new ScriptedModel([.. AnalystScript.Stages("queue-wait"), AnalystScript.Submit("queue-wait")]),
            names: new StubNames(fault: new InvalidOperationException("redis down")));

        var finding = await processor.AnalyseAsync(Config(), CancellationToken.None);

        Assert.Null(finding.Target.Name);
        Assert.Equal(Guid.Parse("11111111-1111-1111-1111-111111111111"), finding.Target.WorkflowId);
    }

    [Fact]
    public async Task TheDispatchTotalIncludesTheGateThatTheBudgetDoesNotCover()
    {
        // The budget bounds only the investigation; the fitness gate runs first and outside it.
        // The dispatch total is what the finding really cost, so it must count both.
        var meter = new TokenMeter();
        var bit = new MeteredAnalystModel(new ScriptedModel(FitBit(), FitBit(), FitBit()), meter);
        var loopModel = new MeteredAnalystModel(
            new ScriptedModel([.. AnalystScript.Stages("queue-wait"), AnalystScript.Submit("queue-wait")]), meter);
        var processor = Processor(bit, loopModel, meter: meter);

        var finding = await processor.AnalyseAsync(Config(), CancellationToken.None);

        var investigationCalls = AnalystScript.Stages("queue-wait").Length + 1;
        Assert.Equal(investigationCalls, finding.Usage.Calls);
        Assert.NotNull(finding.Usage.Dispatch);
        Assert.True(finding.Usage.Dispatch!.Calls > investigationCalls);
    }

    [Fact]
    public void TheContractPromptDelimitsThePayloadPromptAndKeepsTheStagesCompiled()
    {
        var composed = ContractPrompt.Compose("payload judgment here");

        Assert.Contains("record_plan", composed, StringComparison.Ordinal);
        Assert.Contains("submit_finding", composed, StringComparison.Ordinal);
        Assert.Contains("payload judgment here", composed, StringComparison.Ordinal);
    }

    [Fact]
    public void TheContractPromptTellsTheModelToCopyCriteriaAndHypothesisNamesVerbatim()
    {
        // Point 6: StageAssertions tolerates whitespace differences on a ruledOut entry's
        // disconfirmingCriterion and on hypothesis names across record_plan, record_verification and
        // ruledOut -- but never a paraphrase. If the prompt does not say "verbatim" in so many words,
        // a well-behaved investigation can still fail a check with no clue in the message that the
        // fix is "copy the words, not the meaning."
        var composed = ContractPrompt.Compose("payload judgment here");

        Assert.Contains("verbatim", composed, StringComparison.OrdinalIgnoreCase);
    }
}

/// <summary>A model that throws the given exception on every call, never replying at all.</summary>
internal sealed class ThrowingModel(Exception toThrow) : IAnalystModel
{
    public Task<ModelReply> SendAsync(
        string system, IReadOnlyList<ModelTurn> transcript, IReadOnlyList<ToolSpec> tools, CancellationToken ct)
        => throw toThrow;
}

/// <summary>A name source that answers from a dictionary, or throws the given fault.</summary>
internal sealed class StubNames(IReadOnlyDictionary<Guid, string>? found = null, Exception? fault = null) : IEntityNameSource
{
    public Task<IReadOnlyDictionary<Guid, string>> ReadNamesAsync(IReadOnlyCollection<EntityRef> refs)
        => fault is not null
            ? throw fault
            : Task.FromResult<IReadOnlyDictionary<Guid, string>>(found ?? new Dictionary<Guid, string>());
}
