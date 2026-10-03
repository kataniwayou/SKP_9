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
/// <b>Every scenario starts from a REAL window.</b> <c>endless-feed-edges</c> is captured from the
/// live panels by <see cref="AnalystReplayCapture"/>, after the edges model was deployed, and its answer key
/// verified independently of them (see its <c>window.json</c>). A scenario plants at most one fault on top of it and leaves every other panel
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
/// <b>Where the assertion stops, the scorecard takes over.</b> Whether a claim names a stall is a
/// judgement about what it says, which no assertion here can make reliably. A stall is asserted only as
/// "reported, and resting on run-boundaries"; every claim and reason is written to the scorecard for a
/// human to read.
/// </para>
/// <para>
/// <b>Every scenario skips unless the capture has edges.</b> <c>busy-mixed-feed</c> predates StepRole
/// and has no <c>run-boundaries.json</c>; <c>endless-feed-edges</c> (captured 2026-10-02 after the edges
/// deploy) has one. No hand-built reading stands in for a capture.
/// </para>
/// </summary>
public sealed class AnalystReplayScenarios
{
    private const string Window = "endless-feed-edges";

    private static readonly string[] AllPanels =
    [
        "step-outcomes", "step-failures", "refused-messages", "run-boundaries",
        "queue-wait", "processor-liveness", "dead-letter-depth",
    ];

    private static void SkipUnlessCaptureHasEdges() => Assert.SkipUnless(
        File.Exists(Path.Combine(AppContext.BaseDirectory, "Analyst", "Fixtures", "replay", Window, "run-boundaries.json")),
        "the captured window predates the edges model; recapture it after deployment (plan Task 5)");

    private static void SkipUnlessEnabled() => Assert.SkipUnless(
        Environment.GetEnvironmentVariable("SKP_ANALYST_REPLAY") == "1",
        "set SKP_ANALYST_REPLAY=1 to replay a prompt against the captured scenarios; every run is a full "
        + "investigation against the real model and costs real credit");

    private static int Runs()
        => int.TryParse(Environment.GetEnvironmentVariable("SKP_ANALYST_REPLAY_RUNS"), out var n) && n > 0 ? n : 1;

    /// <summary><c>SKP_ANALYST_PROMPT</c>, absolute or repo-relative; v12, the edges prompt, by default.</summary>
    private static (string Path, string Text) Prompt()
    {
        var configured = Environment.GetEnvironmentVariable("SKP_ANALYST_PROMPT") ?? "tools/analyst-prompt-v12.txt";
        var path = System.IO.Path.IsPathRooted(configured)
            ? configured
            : System.IO.Path.Combine(ReplayFixtures.RepoRoot(), configured);
        Assert.True(File.Exists(path), $"prompt not found at {path}");
        return (path, File.ReadAllText(path).Trim());
    }

    // ── the scenarios ─────────────────────────────────────────────────────────────────────────────

    /// <summary>The captured window as it was: 75 deliberate input failures, 25 policy cancellations, no loss.</summary>
    private static FixturePanelReader BusyAndHealthy() => ReplayFixtures.Reader(Window);

    /// <summary>
    /// Work thrown away during the window: the file-persister's dead-letter queue climbs from 0 to 17
    /// halfway through while 17 parked refusals land for this workflow. Two panels agree on one loss.
    /// <para>
    /// <b>Consistent with the loss, not just decorated with it.</b> Each of the 17 is a good item's
    /// branch whose dispatch to S9 (split-filepersister) was refused: it never produced its S9 or S10
    /// Completed record. So the outcome totals lose 34 Completed. Leaving the captured totals untouched
    /// planted a loss that left no trace in the counts -- which cannot happen -- and the model spent an
    /// insight hunting the inconsistency.
    /// </para>
    /// <para>
    /// <b>The edges are untouched.</b> The loss is refused before split-filepersister, on a good item's
    /// path, and no good item's branch reaches a step with no successors (it ends at split-exporter,
    /// whose only successor accepts Failed), so the planted loss cannot change any terminal row; the
    /// dispatches behind entry happened. run-boundaries stays byte for byte as captured. Every other
    /// number is derived from the capture, so the plant stays consistent with whatever window
    /// <see cref="Window"/> names.
    /// </para>
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

        // Same scope as the captured reading: every record of the workflow in the window.
        var workflowRecords = (int)JsonNode.Parse(reader.ValueOf("refused-messages"))!["totalWorkflowRecords"]!;
        var refusals = new JsonObject
        {
            ["totalWorkflowRecords"] = workflowRecords,
            ["refusedCount"] = 17,
            ["parked"] = 17,
            ["notParked"] = 0,
            ["byQueue"] = new JsonObject { ["processor-c046fb57-6fa3-4227-8cb0-103e933652e3"] = 17 },
            ["samples"] = new JsonArray(new JsonObject
            {
                ["@timestamp"] = ReplayFixtures.Window(Window).From.AddMinutes(11).AddSeconds(57.118)
                    .UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", System.Globalization.CultureInfo.InvariantCulture),
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

        const int lost = 34;
        var outcomes = JsonNode.Parse(reader.ValueOf("step-outcomes"))!;
        var total = (int)outcomes["totalOutcomeRecords"]! - lost;
        outcomes["totalOutcomeRecords"] = total;
        outcomes["completed"] = (int)outcomes["completed"]! - lost;


        return reader
            .Planted("dead-letter-depth", depth.ToJsonString())
            .Planted("refused-messages", refusals.ToJsonString(), samples: workflowRecords)
            .Planted("step-outcomes", outcomes.ToJsonString(), samples: total)
            .Planted("step-failures", ReplaceTotal(reader.ValueOf("step-failures"), total), samples: total);
    }

    /// <summary>The captured step-failures value with its outcome total changed and its samples kept.</summary>
    private static string ReplaceTotal(string stepFailures, int total)
    {
        var node = JsonNode.Parse(stepFailures)!;
        node["totalOutcomeRecords"] = total;
        return node.ToJsonString();
    }

    /// <summary>
    /// A stall after the first hop: fires keep entering, the importer completes each poll and imports,
    /// and nothing after the entry step returns an outcome. step-outcomes carries only the entry step's
    /// outcomes against the items imported; run-boundaries shows entry with recordsImported above 0. The
    /// missing terminal row is not the evidence -- a healthy window may have none.
    /// <para>
    /// <b>Every number is the capture's own.</b> The reading is the captured entry row alone: its
    /// dispatch count, fires, polls and recordsImported unchanged. The split importer returns one
    /// outcome per record it read (recordsImported), not one per fire, so step-outcomes and
    /// step-failures carry that many outcomes, all Completed. totalWorkflowRecords is derived from the
    /// capture, not copied: a stall logs only the entry side, so it is the entry dispatch records
    /// (the entry row's records) + the importer's outcome records (recordsImported, one per item) +
    /// the importer's poll records (importerPolls). The captured 4960 covers the whole run and would
    /// overstate a stall. refused-messages carries the same total, so the two panels sharing that
    /// scope agree.
    /// </para>
    /// </summary>
    private static FixturePanelReader StalledAfterTheFirstHop()
    {
        var reader = BusyAndHealthy();
        var captured = JsonNode.Parse(reader.ValueOf("run-boundaries"))!;
        var entry = captured["byStep"]!.AsArray().Single(r => (string)r!["role"]! == "entry")!;
        var dispatched = (int)entry["records"]!;
        // The split importer's outcomes: one per item it took in. step-outcomes has no step dimension,
        // so the capture's recordsImported is the entered-item count.
        var entered = (int)captured["recordsImported"]!;
        var total = dispatched + entered + (int)captured["importerPolls"]!;

        var edges = new JsonObject
        {
            ["totalWorkflowRecords"] = total,
            ["fires"] = (int)captured["fires"]!,
            ["importerPolls"] = (int)captured["importerPolls"]!,
            ["pollsThatImported"] = (int)captured["pollsThatImported"]!,
            ["drainedPolls"] = (int)captured["drainedPolls"]!,
            ["recordsImported"] = (int)captured["recordsImported"]!,
            ["byStep"] = new JsonArray(new JsonObject
            {
                ["role"] = "entry",
                ["step"] = (string)entry["step"]!,
                ["records"] = dispatched,
            }),
        };

        return reader
            .Planted("step-outcomes",
                $$"""{"totalOutcomeRecords":{{entered}},"completed":{{entered}},"failed":0,"cancelled":0}""", samples: entered)
            .Planted("step-failures", $$"""{"totalOutcomeRecords":{{entered}},"failedCount":0,"samples":[]}""", samples: entered)
            .Planted("run-boundaries", edges.ToJsonString(), samples: dispatched)
            // The same workflow-record scope as the edges' totalWorkflowRecords: two panels that count
            // one scope must not disagree in a plant.
            .Planted("refused-messages",
                $$"""{"totalWorkflowRecords":{{total}},"refusedCount":0,"parked":0,"notParked":0,"byQueue":{},"samples":[]}""",
                samples: total);
    }

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
        "reported, resting on run-boundaries (items imported, recordsImported) set against step-outcomes; a human reads whether it says STALL",
        f => f.Verdict is "Drifting" or "Notable"
             && f.Insights.Any(i => i.Panels.Contains("run-boundaries")));

    // ── the runner ────────────────────────────────────────────────────────────────────────────────

    private static async Task Score(
        string scenario, Func<FixturePanelReader> build, string expected, Func<AnalystFinding, bool> correct)
    {
        SkipUnlessCaptureHasEdges();
        SkipUnlessEnabled();

        var (promptPath, prompt) = Prompt();
        var runs = Runs();
        var card = new StringBuilder()
            .AppendLine($"=== {scenario}  prompt={System.IO.Path.GetFileName(promptPath)}  hash={PromptHash.Of(prompt)[..12]}  "
                + $"graph={(WithGraph() ? "on" : "off")}  runs={runs}")
            .AppendLine($"expected: {expected}");
        var passes = 0;

        var file = System.IO.Path.Combine(AppContext.BaseDirectory, "TestResults", $"replay-{System.IO.Path.GetFileNameWithoutExtension(promptPath)}-{(WithGraph() ? "graph" : "nograph")}-{scenario}.txt");
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(file)!);

        // Rewritten after every run, not once at the end: a run is minutes of real model spend, and a
        // process stopped partway (the host reaps background jobs under memory pressure) must not
        // take the finished runs' results with it.
        Task Save(string tail) => File.WriteAllTextAsync(file, card + tail, TestContext.Current.CancellationToken);

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

            await Save($"(in progress: {passes}/{run} so far)" + Environment.NewLine);
        }

        card.AppendLine($"score: {passes}/{runs}");
        await Save("");
        TestContext.Current.TestOutputHelper?.WriteLine(card.ToString());

        Assert.True(passes == runs, $"{passes}/{runs} runs reached the expected conclusion; scorecard at {file}\n{card}");
    }

    /// <summary>The deployed payload's own budgets, so a replay gets the room a live dispatch gets.</summary>
    private static AnalystConfig Config(string prompt) => AnalystGroundTruthLiveTests.Config(prompt, AllPanels) with
    {
        WallClockSeconds = 1200,
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
            NullLogger<AnalystProcessor>.Instance,
            graphs: WithGraph()
                ? new FixedGraphSource(global::Processor.Analyst.Graph.GraphBriefing.Of(ReplayFixtures.Graph(Window)))
                : null,
            // "Now" is the captured window's end, so the window the model is asked about is the one
            // the readings came from. Left at the real clock, every replay asked about the last
            // fifteen minutes and served data timestamped hours earlier -- and the model noticed.
            clock: new Microsoft.Extensions.Time.Testing.FakeTimeProvider(ReplayFixtures.Window(Window).To));
    }

    /// <summary>
    /// The captured running graph is injected unless <c>SKP_ANALYST_REPLAY_GRAPH=0</c>, so the same prompt
    /// can be scored with and without it.
    /// </summary>
    private static bool WithGraph() => Environment.GetEnvironmentVariable("SKP_ANALYST_REPLAY_GRAPH") != "0";
}
