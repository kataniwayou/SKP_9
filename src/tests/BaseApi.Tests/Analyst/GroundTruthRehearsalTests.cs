using Microsoft.Extensions.Logging.Abstractions;
using Processor.Analyst.Bit;
using Processor.Analyst.Model;
using Xunit;

namespace BaseApi.Tests.Analyst;

/// <summary>
/// The third part of the gate, wired through <see cref="PreflightBit"/>. Each test scripts the judge
/// and the rehearsal loop from one model, in order: the ballots first, then whatever the rehearsal's
/// investigation says.
/// </summary>
public sealed class GroundTruthRehearsalTests
{
    private const string DeadLetterPanel = "dead-letter-depth";

    private static readonly string Structured = string.Join("\n\n",
        "Preamble.",
        "STAGE 1 - RESEARCH. " + new string('x', 100),
        "STAGE 2 - VALIDATE. " + new string('x', 100),
        "STAGE 3 - PLAN. " + new string('x', 100),
        "STAGE 4 - EXECUTE. " + new string('x', 100),
        "STAGE 5 - VERIFY. " + new string('x', 100));

    private static ModelReply Fit() => ModelReply.Of(
        ScriptedModel.Call("report_fitness", new { problems = Array.Empty<object>() }));

    private static ModelReply Unfit() => ModelReply.Of(
        ScriptedModel.Call("report_fitness", new
        {
            problems = new[] { new { stage = "plan", kind = "missing", offending = "…" } },
        }));

    /// <summary>An investigation that reaches the quiet ending.</summary>
    private static ModelReply[] ConcludesNothing() =>
    [
        .. AnalystScript.Stages(DeadLetterPanel),
        ModelReply.Of(ScriptedModel.Call("report_no_finding", new { reason = "every panel clean" })),
    ];

    /// <summary>An investigation that reports a finding.</summary>
    private static ModelReply[] ConcludesFinding() =>
    [
        .. AnalystScript.Stages(DeadLetterPanel),
        AnalystScript.Submit(DeadLetterPanel),
    ];

    private static (PreflightBit Bit, ScriptedModel Model) Build(params ModelReply[] script)
    {
        var model = new ScriptedModel(script);
        var rehearsal = new GroundTruthRehearsal(
            model, TimeProvider.System, NullLoggerFactory.Instance,
            NullLogger<GroundTruthRehearsal>.Instance);

        return (new PreflightBit(model, new BitCache(new BaseApi.Tests.Support.InMemorySharedState(), "test-model/high"), rehearsal), model);
    }

    [Fact]
    public async Task APromptThatStaysQuietAndThenReportsTheFaultPasses()
    {
        var (bit, _) = Build([
            Fit(), Fit(), Fit(),                 // the judge
            .. ConcludesNothing(),               // quiet window: correctly silent
            .. ConcludesFinding(),               // planted fault: correctly reported
        ]);

        var verdict = await bit.CheckAsync(Structured, CancellationToken.None);

        Assert.True(verdict.Fit);
    }

    [Fact]
    public async Task APromptThatInventsAFindingOnAQuietWindowFails()
    {
        // The false positive, and the one that matters most: a monitor firing twice an hour that
        // cries wolf is one an operator stops reading.
        var (bit, _) = Build([Fit(), Fit(), Fit(), .. ConcludesFinding()]);

        var verdict = await bit.CheckAsync(Structured, CancellationToken.None);

        Assert.False(verdict.Fit);
        var problem = Assert.Single(verdict.Problems);
        Assert.Equal("verify", problem.Stage);
        Assert.Contains("quiet", problem.Offending, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task APromptThatMissesThePlantedDeadLetterDepthFails()
    {
        var (bit, _) = Build([
            Fit(), Fit(), Fit(),
            .. ConcludesNothing(),               // quiet window: correct
            .. ConcludesNothing(),               // planted fault: missed
        ]);

        var verdict = await bit.CheckAsync(Structured, CancellationToken.None);

        Assert.False(verdict.Fit);
        var problem = Assert.Single(verdict.Problems);
        Assert.Equal("verify", problem.Stage);
        Assert.Contains("dead-letter", problem.Offending, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task AFailingQuietWindowCostsNoSecondRehearsal()
    {
        // The scenarios are ordered so the cheap rejection happens first: nothing is scripted for a
        // second investigation, and running one would exhaust the script and throw.
        var (bit, model) = Build([Fit(), Fit(), Fit(), .. ConcludesFinding()]);

        await bit.CheckAsync(Structured, CancellationToken.None);

        Assert.Equal(3 + ConcludesFinding().Length, model.Received.Count);
    }

    [Fact]
    public async Task AnUnfitPromptIsNeverRehearsed()
    {
        // The rehearsal is the expensive part; there is nothing to learn from replaying a prompt the
        // judge has already condemned. Five ballots and not one investigation turn.
        var (bit, model) = Build(Unfit(), Unfit(), Unfit(), Unfit(), Unfit());

        var verdict = await bit.CheckAsync(Structured, CancellationToken.None);

        Assert.False(verdict.Fit);
        Assert.Equal("plan", Assert.Single(verdict.Problems).Stage);
        Assert.Equal(5, model.Received.Count);
    }

    [Fact]
    public async Task AStructurallyBrokenPromptIsNeverJudgedOrRehearsed()
    {
        var (bit, model) = Build(Fit(), Fit(), Fit());

        var verdict = await bit.CheckAsync("Prose with no stages.", CancellationToken.None);

        Assert.False(verdict.Fit);
        Assert.Empty(model.Received);
    }

    [Fact]
    public async Task TheRehearsalIsPaidOncePerPromptPerProcess()
    {
        var (bit, model) = Build([
            Fit(), Fit(), Fit(), .. ConcludesNothing(), .. ConcludesFinding(),
        ]);

        await bit.CheckAsync(Structured, CancellationToken.None);
        var spent = model.Received.Count;

        // A second dispatch of the same prompt: the script is exhausted, so any further model call
        // would throw rather than quietly re-paying for a rehearsal.
        var second = await bit.CheckAsync(Structured, CancellationToken.None);

        Assert.True(second.Fit);
        Assert.Equal(spent, model.Received.Count);
    }
}
