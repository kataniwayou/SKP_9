using System.Net.Http.Headers;
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Processor.Analyst;
using Processor.Analyst.Bit;
using Processor.Analyst.Loop;
using Processor.Analyst.Model;
using BaseApi.Tests.Analyst;
using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// The second half of validating a prompt: does it reach the right conclusion about data whose
/// content is already known.
/// <para>
/// <b>Everything else that checks a prompt is structurally incapable of seeing this.</b>
/// <see cref="PromptStructure"/> decides whether the five stages exist; the BIT's judge decides
/// whether they describe a workable method, graded against one hardcoded hypothetical. Neither ever
/// reads a panel, so neither can notice a prompt that is well formed, admissible, points at exactly
/// the right panels — and draws the wrong conclusion from them. That class of fault is only visible
/// against ground truth, which is what <see cref="FixturePanelReader"/> supplies: the real model, the
/// real five-stage loop, and panel readings this test wrote itself.
/// </para>
/// <para>
/// <b>Deliberately not wired into <see cref="PreflightBit"/>.</b> A replay is a whole multi-turn
/// investigation, so it is far more stochastic than the single call the exam makes — and the BIT
/// freezes its verdict permanently. Putting a replay behind that freeze would gamble the deployment
/// on one wandering rehearsal, which is the exact failure this session spent its time removing. It
/// belongs before a prompt is deployed, run deliberately and more than once, not on the dispatch
/// path.
/// </para>
/// <para>
/// <b>The quiet case matters more than the loud one.</b> A monitor that fires twice an hour and
/// cries wolf trains its operator to ignore it, so a false positive costs more than a missed
/// finding. That scenario is first for that reason.
/// </para>
/// </summary>
public sealed class AnalystGroundTruthLiveTests
{
    /// <summary>
    /// Separate from SKP_REALSTACK: this needs the model endpoint and a funded key, not the cluster.
    /// It also spends real money on every run, which no default test run may ever do.
    /// </summary>
    private static void SkipUnlessEnabled() => Assert.SkipUnless(
        Environment.GetEnvironmentVariable("SKP_ANALYST_REPLAY") == "1",
        "set SKP_ANALYST_REPLAY=1 to replay the deployed prompt against fixture panels; "
        + "each scenario is a full investigation against the real model and costs real credit");

    /// <summary>The prompt under test, read from the file that is deployed rather than a copy.</summary>
    private static string DeployedPrompt()
    {
        var path = Path.Combine(RepoRoot(), "tools", "analyst-prompt-v9.txt");
        Assert.True(File.Exists(path), $"prompt not found at {path}");
        return File.ReadAllText(path).Trim();
    }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);

        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "SK_P.sln")))
        {
            dir = dir.Parent;
        }

        Assert.NotNull(dir);
        return dir!.FullName;
    }

    /// <summary>
    /// The real adapter against the real endpoint. Configuration comes from the environment so a key
    /// never has to be pasted into a test, falling back to the checked-in appsettings the deployment
    /// itself uses.
    /// </summary>
    internal static KimiAnalystModel RealModel()
    {
        var settings = Path.Combine(RepoRoot(), "src", "Processor.Analyst", "appsettings.json");
        using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(settings));
        var model = doc.RootElement.GetProperty("Analyst").GetProperty("Model");

        string From(string env, string key) =>
            Environment.GetEnvironmentVariable(env) ?? model.GetProperty(key).GetString()!;

        var options = new AnalystModelOptions
        {
            BaseUrl = From("Analyst__Model__BaseUrl", "BaseUrl"),
            ModelId = From("Analyst__Model__ModelId", "ModelId"),
            ReasoningEffort = From("Analyst__Model__ReasoningEffort", "ReasoningEffort"),
            ApiKey = From("Analyst__Model__ApiKey", "ApiKey"),
        };

        var http = new HttpClient
        {
            BaseAddress = KimiAnalystModel.NormaliseBaseAddress(options.BaseUrl),
            Timeout = Timeout.InfiniteTimeSpan,
        };

        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", options.ApiKey);

        return new KimiAnalystModel(http, Options.Create(options));
    }

    internal static AnalystConfig Config(string prompt, params string[] panels)
        => new(
            TargetWorkflowId: Guid.Parse("1a56b3ca-e276-4815-87fa-5c2f48ab6dad"),
            WindowMinutes: 15,
            Prompt: prompt,
            PanelSet: panels,
            MaxIterations: 12,
            MaxTokens: 1_500_000,
            WallClockSeconds: 240);

    /// <summary>
    /// The processor with real judgement and invented evidence. The BIT is given a private in-memory
    /// store, so the replay never reads or writes the deployment's shared verdict.
    /// </summary>
    private static AnalystProcessor Processor(FixturePanelReader panels)
    {
        var model = RealModel();

        return new AnalystProcessor(
            new PreflightBit(model, new BitCache(new BaseApi.Tests.Support.InMemorySharedState(), "live-replay")),
            new InvestigationLoop(model, panels, TimeProvider.System,
                NullLogger<InvestigationLoop>.Instance),
            NullLogger<AnalystProcessor>.Instance);
    }

    /// <summary>Every panel healthy and every counter benign: there is genuinely nothing to report.</summary>
    private static FixturePanelReader QuietWindow() => new FixturePanelReader()
        .Reading("step-outcomes", "ops", """{"Completed":412,"Failed":0,"Cancelled":3}""", samples: 415)
        .Reading("step-failures", "ops", """{"failed":0,"samples":[]}""", samples: 0)
        .Reading("refused-messages", "ops", """{"refusals":0,"parked":0,"notParked":0,"samples":[]}""", samples: 0)
        .Reading("run-boundaries", "business",
            """{"totalWorkflowRecords":240,"roleRecords":60,"fires":30,"importerPolls":30,"pollsThatImported":0,"drainedPolls":30,"byStep":[{"role":"entry","step":"importer","outcomes":30}]}""",
            samples: 30)
        .Reading("queue-wait", "ops", """{"meanSeconds":0.013,"max":0.021}""", samples: 91)
        .Reading("processor-liveness", "ops", """{"ready":1.0,"replicas":2}""", samples: 60)
        .Reading("dead-letter-depth", "ops", """{"queues":{"processor-a.dead":0,"processor-b.dead":0}}""", samples: 60);

    /// <summary>
    /// The same window with one unambiguous fault planted: work thrown away DURING the window. A
    /// dead-letter queue grows from 0 to 17 while 17 parked refusals land, so two panels agree on the
    /// same loss -- the insight a prompt is expected to draw.
    /// </summary>
    private static FixturePanelReader WindowLosingWork() => QuietWindow()
        .Reading("dead-letter-depth", "ops",
            """{"queues":{"processor-a.dead":{"windowStart":0,"windowEnd":17},"processor-b.dead":{"windowStart":0,"windowEnd":0}}}""",
            samples: 60)
        .Reading("refused-messages", "ops",
            """{"refusals":17,"parked":17,"notParked":0,"samples":[{"template":"the delivery was parked","exception":"the step's input could not be read from L2"}]}""",
            samples: 17);

    /// <summary>
    /// An old backlog: a dead-letter depth that sits flat across the whole window, with no parked
    /// refusals and every run finishing. Nothing was thrown away in this window, so other panels rule
    /// the dead-letter hypothesis out and there is no insight to report.
    /// </summary>
    private static FixturePanelReader WindowWithAStandingBacklog() => QuietWindow()
        .Reading("dead-letter-depth", "ops",
            """{"queues":{"processor-a.dead":{"windowStart":10,"windowEnd":10},"processor-b.dead":{"windowStart":0,"windowEnd":0}}}""",
            samples: 60);

    private static readonly string[] AllPanels =
    [
        "step-outcomes", "step-failures", "refused-messages", "run-boundaries",
        "queue-wait", "processor-liveness", "dead-letter-depth",
    ];

    [Fact]
    public async Task AQuietWindowProducesNoFinding()
    {
        SkipUnlessEnabled();

        var processor = Processor(QuietWindow());
        using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(12));

        // No finding is published as a Quiet verdict: the run completes either way.
        var quiet = await processor.AnalyseAsync(Config(DeployedPrompt(), AllPanels), cts.Token);

        Assert.True(
            quiet.Verdict == "Quiet",
            "a window with no fault must produce no finding, because a monitor that cries wolf twice "
            + $"an hour is one an operator learns to ignore. Got: {quiet.Verdict} -- "
            + string.Join("; ", quiet.Insights.Select(i => i.Claim)));
    }

    [Fact]
    public async Task AStandingBacklogIsRuledOutAndProducesNoFinding()
    {
        SkipUnlessEnabled();

        var processor = Processor(WindowWithAStandingBacklog());
        using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(12));

        var quiet = await processor.AnalyseAsync(Config(DeployedPrompt(), AllPanels), cts.Token);

        Assert.True(
            quiet.Verdict == "Quiet",
            "a flat dead-letter depth with no parked refusals and every run finishing is an old "
            + "backlog, not loss in this window, and restating it is not an insight. Got: "
            + $"{quiet.Verdict} -- " + string.Join("; ", quiet.Insights.Select(i => i.Claim)));
    }

    [Fact]
    public async Task PlantedLossIsFoundAndCorrelated()
    {
        SkipUnlessEnabled();

        var processor = Processor(WindowLosingWork());
        using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(12));

        var finding = await processor.AnalyseAsync(Config(DeployedPrompt(), AllPanels), cts.Token);

        Assert.NotNull(finding);

        // Cited, not merely mentioned: the finding has to rest on the panel that carries the fault.
        var cited = finding.Evidence.Select(e => e.PanelId)
            .Concat(finding.Trace.Where(t => t.DataReturned).Select(t => t.PanelId))
            .ToList();

        Assert.Contains("dead-letter-depth", cited);

        // And the loss must be an insight, not a reading: some insight has to correlate the
        // growing depth with the parked refusals that account for it.
        Assert.Contains(finding.Insights, i =>
            i.Panels.Contains("dead-letter-depth") && i.Panels.Contains("refused-messages"));
    }
}
