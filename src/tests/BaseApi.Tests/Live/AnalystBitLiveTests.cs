using Microsoft.Extensions.Logging.Abstractions;
using Processor.Analyst.Bit;
using BaseApi.Tests.Analyst;
using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// The whole preflight BIT, in Full mode, against the real model: the structure check, the judge's
/// quorum and both ground-truth rehearsals. This is what a dispatch pays the first time it sees a
/// prompt, run deliberately before <c>Analyst__Bit__Mode</c> goes back to Full, so a prompt the exam
/// would refuse is found here rather than as a fire that fails.
/// <para>
/// <b>Costs real credit:</b> up to five judge calls and two full investigations, roughly an
/// investigation and a half. The verdict goes to a private in-memory store, never the deployment's.
/// </para>
/// </summary>
public sealed class AnalystBitLiveTests
{
    private static void SkipUnlessEnabled() => Assert.SkipUnless(
        Environment.GetEnvironmentVariable("SKP_ANALYST_REPLAY") == "1",
        "set SKP_ANALYST_REPLAY=1 to run the full BIT against the real model; it costs real credit");

    /// <summary><c>SKP_ANALYST_PROMPT</c>, absolute or repo-relative; v14 by default.</summary>
    private static string Prompt()
    {
        var configured = Environment.GetEnvironmentVariable("SKP_ANALYST_PROMPT") ?? "tools/analyst-prompt-v14.txt";
        var path = Path.IsPathRooted(configured) ? configured : Path.Combine(ReplayFixtures.RepoRoot(), configured);
        Assert.True(File.Exists(path), $"prompt not found at {path}");
        return File.ReadAllText(path).Trim();
    }

    [Fact]
    public async Task TheDeployedPromptPassesTheFullBit()
    {
        SkipUnlessEnabled();

        var model = AnalystGroundTruthLiveTests.RealModel();
        var rehearsal = new GroundTruthRehearsal(
            model, TimeProvider.System, NullLoggerFactory.Instance, NullLogger<GroundTruthRehearsal>.Instance);
        var bit = new PreflightBit(
            model, new BitCache(new BaseApi.Tests.Support.InMemorySharedState(), "live-bit"), rehearsal);

        var verdict = await bit.CheckAsync(Prompt(), TestContext.Current.CancellationToken);

        Assert.True(verdict.Fit, "the BIT refused the prompt: "
            + string.Join("; ", verdict.Problems.Select(p => $"{p.Stage}: {p.Kind} -- {p.Offending}")));
    }
}
