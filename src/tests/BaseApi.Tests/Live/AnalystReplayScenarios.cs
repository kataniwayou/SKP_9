using System.Text;
using System.Text.Json.Nodes;
using BaseApi.Tests.Analyst;
using BaseApi.Tests.Support;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Processor.Analyst;
using Processor.Analyst.Bit;
using Processor.Analyst.Loop;
using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// The proof-of-concept measuring stick: a prompt replayed against windows whose truth is known, more
/// than once, scored against that truth.
/// <para>
/// <b>Every scenario starts from a REAL window.</b> <c>busy-mixed-feed</c> was captured from the live
/// panels by <see cref="AnalystReplayCapture"/> and its answer key verified independently of them (see
/// its <c>window.json</c>). A scenario plants at most one fault on top of it and leaves every other panel
/// byte for byte as production returned it, so a wrong conclusion cannot be blamed on a fixture shape the
/// real panels never produce.
/// </para>
/// <para>
/// <b>Run each scenario several times; one pass proves nothing.</b> The model cannot be pinned, so a
/// prompt is measured as a pass rate. <c>SKP_ANALYST_REPLAY_RUNS</c> sets the count (default 1) and every
/// run is scored even after one fails, so the scorecard shows the rate, not just the first miss.
/// </para>
/// <para>
/// <b>The BIT runs in <see cref="BitMode.StructureOnly"/>.</b> This harness measures what a prompt
/// concludes, not whether it passes the gate, and the gate would add five judge calls and two
/// rehearsals to every run.
/// </para>
/// <para>
/// <b>Where the assertion stops, the scorecard takes over.</b> Telling a stall from a reporting fault is
/// a judgement about what a claim says, which no assertion here can make reliably. Both are asserted only
/// as "reported, and resting on run-boundaries"; every claim and reason is written to the scorecard for a
/// human to read.
/// </para>
/// </summary>
public sealed class AnalystReplayScenarios
{
    private const string Window = "busy-mixed-feed";

    private static readonly string[] AllPanels =
    [
        "step-outcomes", "step-failures", "refused-messages", "run-boundaries",
        "queue-wait", "processor-liveness", "dead-letter-depth",
    ];

    private static void SkipUnlessEnabled() => Assert.SkipUnless(
        Environment.GetEnvironmentVariable("SKP_ANALYST_REPLAY") == "1",
        "set SKP_ANALYST_REPLAY=1 to replay a prompt against the captured scenarios; every run is a full "
        + "investigation against the real model and costs real credit");

    private static int Runs()
        => int.TryParse(Environment.GetEnvironmentVariable("SKP_ANALYST_REPLAY_RUNS"), out var n) && n > 0 ? n : 1;

    /// <summary><c>SKP_ANALYST_PROMPT</c>, absolute or repo-relative; the deployed v9 by default.</summary>
    private static (string Path, string Text) Prompt()
    {
        var configured = Environment.GetEnvironmentVariable("SKP_ANALYST_PROMPT") ?? "tools/analyst-prompt-v9.txt";
        var path = System.IO.Path.IsPathRooted(configured)
            ? configured
            : System.IO.Path.Combine(ReplayFixtures.RepoRoot(), configured);
        Assert.True(File.Exists(path), $"prompt not found at {path}");
        return (path, File.ReadAllText(path).Trim());
    }

    // ── the scenarios ─────────────────────────────────────────────────────────────────────────────

    /// <summary>The captured window as it was: 54 deliberate input failures, 18 policy cancellations, no loss.</summary>
    private static FixturePanelReader BusyAndHealthy() => ReplayFixtures.Reader(Window);

    /// <summary>
    /// Work thrown away during the window: the file-persister's dead-letter queue climbs from 0 to 17
    /// halfway through while 17 parked refusals land for this workflow. Two panels agree on one loss.
    /// </summary>
    private static FixturePanelReader LosingWork()
    {
        const string queue = "processor-c046fb57-6fa3-4227-8cb0-103e933652e3.dead";
        var reader = BusyAndHealthy();

        var depth = JsonNode.Parse(reader.ValueOf("dead-letter-depth"))!;
        foreach (var series in depth["series"]!.AsArray())
        {
            if ((string?)series!["labels"]!["queue"] != queue)
            {
                continue;
            }

            var points = series["points"]!.AsArray();
            for (var i = 0; i < points.Count; i++)
            {
                points[i]!["value"] = i < points.Count / 2 ? 0 : Math.Min(17, (i - points.Count / 2 + 1) * 2);
            }
        }

        var refusals = new JsonObject
        {
            ["totalWorkflowRecords"] = 6215,
            ["refusedCount"] = 17,
            ["parked"] = 17,
            ["notParked"] = 0,
            ["byQueue"] = new JsonObject { ["processor-c046fb57-6fa3-4227-8cb0-103e933652e3"] = 17 },
            ["samples"] = new JsonArray(new JsonObject
            {
                ["@timestamp"] = "2026-10-01T19:19:42.118Z",
                ["attributes"] = new JsonObject
                {
                    ["Queue"] = "processor-c046fb57-6fa3-4227-8cb0-103e933652e3",
                    ["Type"] = "ProcessDispatch",
                    ["exception.type"] = "StackExchange.Redis.RedisTimeoutException",
                    ["exception.message"] = "Timeout performing GET skp:data:3f2c… (5000ms)",
                    ["{OriginalFormat}"] = global::Messaging.Contracts.RefusalTemplates.Parked,
                },
            }),
        };

        return reader
            .Planted("dead-letter-depth", depth.ToJsonString())
            .Planted("refused-messages", refusals.ToJsonString(), samples: 6215);
    }

    /// <summary>
    /// A stall after the first hop: fires keep entering, the importer completes each poll, and nothing
    /// downstream produces an outcome or ends a branch — not even an empty poll's Cancelled.
    /// </summary>
    private static FixturePanelReader StalledAfterTheFirstHop() => BusyAndHealthy()
        .Planted("step-outcomes", """{"totalOutcomeRecords":15,"completed":15,"failed":0,"cancelled":0}""", samples: 15)
        .Planted("step-failures", """{"totalOutcomeRecords":15,"failedCount":0,"samples":[]}""", samples: 15)
        .Planted("run-boundaries",
            """{"totalWorkflowRecords":1874,"entry":16,"terminal":0,"importerPolls":15,"drainedPolls":0}""",
            samples: 1874);

    /// <summary>
    /// The work finishes and its end is not recorded: every outcome panel is the healthy capture, but
    /// run-boundaries counts no terminal at all. The system is fine; the evidence about it is not.
    /// </summary>
    private static FixturePanelReader EndsNotRecorded() => BusyAndHealthy()
        .Planted("run-boundaries",
            """{"totalWorkflowRecords":6215,"entry":16,"terminal":0,"importerPolls":15,"drainedPolls":0}""");

    [Fact]
    public Task ABusyHealthyWindowIsQuiet() => Score(
        "busy-healthy", BusyAndHealthy,
        "Quiet: the failures and cancellations are the feed's deliberate bad input and policy",
        f => f.Verdict == "Quiet");

    [Fact]
    public Task PlantedLossIsReportedFromBothPanels() => Score(
        "loss", LosingWork,
        "reported, with an insight correlating dead-letter-depth and refused-messages",
        f => f.Verdict is "Drifting" or "Notable"
             && f.Insights.Any(i => i.Panels.Contains("dead-letter-depth") && i.Panels.Contains("refused-messages")));

    [Fact]
    public Task AStallIsReported() => Score(
        "stall", StalledAfterTheFirstHop,
        "reported, resting on run-boundaries (fires enter, nothing ends); a human reads whether it says STALL",
        f => f.Verdict is "Drifting" or "Notable"
             && f.Insights.Any(i => i.Panels.Contains("run-boundaries")));

    [Fact]
    public Task UnrecordedEndsAreReported() => Score(
        "ends-not-recorded", EndsNotRecorded,
        "reported, correlating run-boundaries with step-outcomes; a human reads whether it says the RECORDING is at fault",
        f => f.Verdict is "Drifting" or "Notable"
             && f.Insights.Any(i => i.Panels.Contains("run-boundaries") && i.Panels.Contains("step-outcomes")));

    // ── the runner ────────────────────────────────────────────────────────────────────────────────

    private static async Task Score(
        string scenario, Func<FixturePanelReader> build, string expected, Func<AnalystFinding, bool> correct)
    {
        SkipUnlessEnabled();

        var (promptPath, prompt) = Prompt();
        var runs = Runs();
        var card = new StringBuilder()
            .AppendLine($"=== {scenario}  prompt={System.IO.Path.GetFileName(promptPath)}  hash={PromptHash.Of(prompt)[..12]}  runs={runs}")
            .AppendLine($"expected: {expected}");
        var passes = 0;

        for (var run = 1; run <= runs; run++)
        {
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(12));
                var finding = await Processor(build()).AnalyseAsync(Config(prompt), cts.Token);
                var ok = correct(finding);
                passes += ok ? 1 : 0;

                card.AppendLine($"--- run {run}: {(ok ? "PASS" : "FAIL")}  verdict={finding.Verdict}  "
                    + $"calls={finding.Usage.Calls}  elapsed={finding.Usage.ElapsedSeconds}s  ruledOut={finding.RuledOut.Count}");
                foreach (var insight in finding.Insights)
                {
                    card.AppendLine($"    insight [{string.Join(",", insight.Panels)}] {insight.Claim}");
                }

                if (finding.Reason is { } reason)
                {
                    card.AppendLine($"    reason: {reason}");
                }
            }
            catch (Exception ex) when (ex is not Xunit.Sdk.XunitException)
            {
                card.AppendLine($"--- run {run}: ERROR  {ex.GetType().Name}: {ex.Message}");
            }
        }

        card.AppendLine($"score: {passes}/{runs}");

        var file = System.IO.Path.Combine(AppContext.BaseDirectory, "TestResults", $"replay-{scenario}.txt");
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(file)!);
        await File.WriteAllTextAsync(file, card.ToString(), TestContext.Current.CancellationToken);
        TestContext.Current.TestOutputHelper?.WriteLine(card.ToString());

        Assert.True(passes == runs, $"{passes}/{runs} runs reached the expected conclusion; scorecard at {file}\n{card}");
    }

    /// <summary>The deployed payload's own budgets, so a replay gets the room a live dispatch gets.</summary>
    private static AnalystConfig Config(string prompt) => AnalystGroundTruthLiveTests.Config(prompt, AllPanels) with
    {
        WallClockSeconds = 600,
    };

    private static AnalystProcessor Processor(FixturePanelReader panels)
    {
        var model = AnalystGroundTruthLiveTests.RealModel();

        return new AnalystProcessor(
            new PreflightBit(
                model,
                new BitCache(new InMemorySharedState(), "replay"),
                options: Options.Create(new AnalystBitOptions { Mode = BitMode.StructureOnly })),
            new InvestigationLoop(model, panels, TimeProvider.System, NullLogger<InvestigationLoop>.Instance),
            NullLogger<AnalystProcessor>.Instance);
    }
}
