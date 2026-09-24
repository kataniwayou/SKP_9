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
    private static AnalystConfig Config(string prompt = "look for drift", int window = 360)
        => new(
            TargetWorkflowId: Guid.Parse("11111111-1111-1111-1111-111111111111"),
            WindowMinutes: window,
            Prompt: prompt,
            PanelSet: ["queue-depth"],
            MaxIterations: 20,
            MaxTokens: 100_000,
            WallClockSeconds: 300);

    private static AnalystProcessor Processor(IAnalystModel bitModel, IAnalystModel loopModel)
        => new(
            new PreflightBit(bitModel, new BitCache(4)),
            new InvestigationLoop(loopModel, new FixturePanelReader()
                    .Reading("queue-depth", "ops", """{"max":4}""", samples: 91),
                new FakeTimeProvider(), NullLogger<InvestigationLoop>.Instance),
            NullLogger<AnalystProcessor>.Instance);

    private static ModelReply FitBit() => ModelReply.Of(
        ScriptedModel.Call("report_fitness", new { problems = Array.Empty<object>() }));

    [Fact]
    public async Task AConfigWithNoPromptFails()
    {
        // The schema guarantees the field is present; it cannot guarantee it survived trimming.
        var processor = Processor(new ScriptedModel(FitBit()), new ScriptedModel());

        await Assert.ThrowsAsync<FailedException>(
            () => processor.AnalyseAsync(Config(prompt: "   "), CancellationToken.None));
    }

    [Fact]
    public async Task AWindowLongerThanTheRetentionFails()
    {
        // A well-formed config the processor cannot work with is still an analysis that could not run.
        var processor = Processor(new ScriptedModel(FitBit()), new ScriptedModel());

        await Assert.ThrowsAsync<FailedException>(
            () => processor.AnalyseAsync(Config(window: 60 * 24 * 400), CancellationToken.None));
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
        var processor = Processor(new ScriptedModel(unfit), new ScriptedModel());

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => processor.AnalyseAsync(Config(), CancellationToken.None));

        Assert.Contains("verify", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ABitJudgeFailureFailsTheDispatch()
    {
        // Point 4: PreflightBit.CheckAsync itself throws AnalysisImpossibleException when the judge
        // answers without calling report_fitness -- a different call site from the loop's, for the
        // same "the analysis could not run" signal. AnalyseAsync's catch has to cover this call site
        // too, not just loop.RunAsync, or this escapes as a raw AnalysisImpossibleException instead
        // of the FailedException every other "could not run" path produces.
        var noToolCall = new ScriptedModel(ModelReply.Of());
        var processor = Processor(noToolCall, new ScriptedModel());

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => processor.AnalyseAsync(Config(), CancellationToken.None));

        Assert.Contains("report_fitness", ex.Message, StringComparison.Ordinal);
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
    public async Task AnAnalysisThatFindsNothingCancels()
    {
        // C1: report_no_finding still needs its five stages recorded -- the check is presence-only,
        // but it applies to this branch too now.
        var processor = Processor(
            new ScriptedModel(FitBit()),
            new ScriptedModel(
                [
                    .. AnalystScript.Stages(),
                    ModelReply.Of(ScriptedModel.Call("report_no_finding", new { reason = "nothing moved" })),
                ]));

        var ex = await Assert.ThrowsAsync<CancelledException>(
            () => processor.AnalyseAsync(Config(), CancellationToken.None));

        Assert.Contains("nothing moved", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AStagelessReportNoFindingFailsRatherThanCancels()
    {
        // C1: a model that records zero stages and calls report_no_finding on turn one has analysed
        // nothing -- that must not read as the same quiet, all-clear disposition as a run that
        // actually reached verification and found nothing worth reporting.
        var processor = Processor(
            new ScriptedModel(FitBit()),
            new ScriptedModel(ModelReply.Of(
                ScriptedModel.Call("report_no_finding", new { reason = "nothing moved" }))));

        await Assert.ThrowsAsync<FailedException>(
            () => processor.AnalyseAsync(Config(), CancellationToken.None));
    }

    [Fact]
    public async Task AnAnalysisThatCannotRunFails()
    {
        var processor = Processor(
            new ScriptedModel(FitBit()),
            new ScriptedModel(new ModelReply([], Text: "hmm", 0, 0)));

        await Assert.ThrowsAsync<FailedException>(
            () => processor.AnalyseAsync(Config(), CancellationToken.None));
    }

    [Fact]
    public async Task ThePromptHashOnTheFindingIsTheHashOfThePayloadPrompt()
    {
        // The one check that makes "edit payload -> restart workflow -> confirm it took" performable.
        var processor = Processor(new ScriptedModel(FitBit()), new ScriptedModel([.. AnalystScript.Stages(), AnalystScript.Submit()]));

        var finding = await processor.AnalyseAsync(Config(), CancellationToken.None);

        Assert.Equal(PromptHash.Of("look for drift"), finding.PromptHash);
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
