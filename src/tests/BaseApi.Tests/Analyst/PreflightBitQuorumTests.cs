using Processor.Analyst.Bit;
using Processor.Analyst.Loop;
using Processor.Analyst.Model;
using Xunit;

namespace BaseApi.Tests.Analyst;

/// <summary>
/// The judgement half of the gate: how ballots become a verdict, and how long that verdict lives.
/// The mechanical half has its own suite in <see cref="PromptStructureTests"/>.
/// </summary>
public sealed class PreflightBitQuorumTests
{
    /// <summary>
    /// Structurally valid, so PromptStructure hands it through to the model. Its wording is
    /// irrelevant — ScriptedModel answers whatever the test told it to.
    /// </summary>
    private static readonly string Structured = string.Join("\n\n",
        "Preamble.",
        "STAGE 1 - RESEARCH. " + new string('x', 100),
        "STAGE 2 - VALIDATE. " + new string('x', 100),
        "STAGE 3 - PLAN. " + new string('x', 100),
        "STAGE 4 - EXECUTE. " + new string('x', 100),
        "STAGE 5 - VERIFY. " + new string('x', 100));

    private static ModelReply Fit() => ModelReply.Of(
        ScriptedModel.Call("report_fitness", new { problems = Array.Empty<object>() }));

    private static ModelReply Unfit(params string[] stages) => ModelReply.Of(
        ScriptedModel.Call("report_fitness", new
        {
            problems = stages.Select(s => new { stage = s, kind = "missing", offending = "…" }).ToArray(),
        }));

    /// <summary>A reply that is not a report_fitness call at all: the prose-answer failure mode.</summary>
    private static ModelReply Prose() => ModelReply.Of();

    private static (PreflightBit Bit, ScriptedModel Model) Build(params ModelReply[] script)
    {
        var model = new ScriptedModel(script);
        return (new PreflightBit(model, new BitCache(new BaseApi.Tests.Support.InMemorySharedState(), "test-model/high")), model);
    }

    [Fact]
    public async Task ThreeAgreeingBallotsSettleItAndTheRestAreNeverCast()
    {
        // Five scripted; once three agree and no stage can still be corroborated, the outcome cannot
        // change, so the remaining two must go unused.
        var (bit, model) = Build(Fit(), Fit(), Fit(), Fit(), Fit());

        var verdict = await bit.CheckAsync(Structured, CancellationToken.None);

        Assert.True(verdict.Fit);
        Assert.Equal(3, model.Received.Count);
    }

    [Fact]
    public async Task ScatteredSingleFlagsDoNotCondemnAnything()
    {
        // The measured pattern across ~50 runs: spurious flags appear once and land on a different
        // stage next time. Neither reaches corroboration, so the prompt is fit.
        var (bit, _) = Build(Unfit("plan"), Fit(), Unfit("execute"), Fit(), Fit());

        var verdict = await bit.CheckAsync(Structured, CancellationToken.None);

        Assert.True(verdict.Fit);
        Assert.Empty(verdict.Problems);
    }

    [Fact]
    public async Task AStageNamedByEnoughJudgesIsCondemnedAndOthersAreNot()
    {
        // plan is named three times and is real; validate is named once and is noise.
        var (bit, _) = Build(
            Unfit("plan"), Unfit("plan", "validate"), Unfit("plan"), Fit(), Fit());

        var verdict = await bit.CheckAsync(Structured, CancellationToken.None);

        Assert.False(verdict.Fit);
        Assert.Equal("plan", Assert.Single(verdict.Problems).Stage);
    }

    [Fact]
    public async Task OneJudgeReportingTwoFaultsInOneStageIsStillOneVoice()
    {
        // A ballot must not corroborate itself: two problems, one stage, one opinion.
        var (bit, _) = Build(Unfit("plan", "plan"), Fit(), Fit(), Fit(), Fit());

        Assert.True((await bit.CheckAsync(Structured, CancellationToken.None)).Fit);
    }

    [Fact]
    public async Task FewerThanThreeUsableBallotsRefusesToDecide()
    {
        // Two good ballots and three spoiled: a verdict that will stand for this replica's lifetime
        // may not rest on two voices.
        var (bit, _) = Build(Prose(), Fit(), Prose(), Fit(), Prose());

        await Assert.ThrowsAsync<AnalysisImpossibleException>(
            () => bit.CheckAsync(Structured, CancellationToken.None));
    }

    [Fact]
    public async Task AStructurallyBrokenPromptIsRejectedWithoutSpendingAModelCall()
    {
        var (bit, model) = Build(Fit(), Fit(), Fit(), Fit(), Fit());

        var verdict = await bit.CheckAsync(
            "Prose with no stages at all. Decide whether anything deserves attention.",
            CancellationToken.None);

        Assert.False(verdict.Fit);
        Assert.Equal(5, verdict.Problems.Count);
        Assert.All(verdict.Problems, p => Assert.Equal("missing", p.Kind));
        Assert.Empty(model.Received);
    }

    [Fact]
    public async Task TheVerdictIsReusedWithinTheProcess()
    {
        // Three ballots for the first check; the script would throw if a second check reached the
        // model, which is what proves the cached verdict was served.
        var (bit, model) = Build(Fit(), Fit(), Fit());

        await bit.CheckAsync(Structured, CancellationToken.None);
        var second = await bit.CheckAsync(Structured, CancellationToken.None);

        Assert.True(second.Fit);
        Assert.Equal(3, model.Received.Count);
    }

    /// <summary>
    /// The boundary of the verdict's lifetime: it is shared while any replica lives, and gone once
    /// they all are. A fresh shared store is what L2 holds after the last replica's TTL lapses.
    /// </summary>
    [Fact]
    public async Task OnceEveryReplicaIsGoneThePromptIsJudgedAgain()
    {
        var (first, firstModel) = Build(Fit(), Fit(), Fit());
        await first.CheckAsync(Structured, CancellationToken.None);
        Assert.Equal(3, firstModel.Received.Count);

        // Every replica gone: same prompt, an empty shared store, and a model asked all over again.
        var (second, secondModel) = Build(Fit(), Fit(), Fit());
        var verdict = await second.CheckAsync(Structured, CancellationToken.None);

        Assert.True(verdict.Fit);
        Assert.Equal(3, secondModel.Received.Count);
    }

    [Fact]
    public async Task ASpoiledBallotIsLoggedWithItsCause()
    {
        // A discarded ballot used to leave no trace, so a check that failed on "0 usable verdicts"
        // could not say whether the judge answered in prose, the backend refused, or the connection
        // never opened. Each spoiled ballot is now a Warning carrying the exception that spoiled it.
        var logger = new BaseApi.Tests.Support.RecordingLogger<PreflightBit>();
        var bit = new PreflightBit(new ScriptedModel(Prose(), Fit(), Fit(), Fit()), new BitCache(new BaseApi.Tests.Support.InMemorySharedState(), "test-model/high"), logger: logger);

        var verdict = await bit.CheckAsync(Structured, CancellationToken.None);

        Assert.True(verdict.Fit);
        var spoiled = Assert.Single(logger.Records, r => r.Level == Microsoft.Extensions.Logging.LogLevel.Warning);
        Assert.Contains("ballot 1 of 5", spoiled.Message, StringComparison.Ordinal);
        Assert.IsType<AnalysisImpossibleException>(spoiled.Exception);
    }
}
