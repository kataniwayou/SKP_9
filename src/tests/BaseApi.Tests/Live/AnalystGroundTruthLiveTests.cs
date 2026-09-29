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
        var path = Path.Combine(RepoRoot(), "tools", "analyst-prompt-v7.txt");
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
    private static KimiAnalystModel RealModel()
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

    private static AnalystConfig Config(string prompt, params string[] panels)
        => new(
            TargetWorkflowId: Guid.Parse("1a56b3ca-e276-4815-87fa-5c2f48ab6dad"),
            WindowMinutes: 15,
            Prompt: prompt,
            PanelSet: panels,
            MaxIterations: 12,
            MaxTokens: 1_500_000,
            WallClockSeconds: 240);

    /// <summary>
    /// The processor with real judgement and invented evidence. The BIT is given no store, so the
    /// replay never reads or writes the deployment's frozen verdict.
    /// </summary>
    private static AnalystProcessor Processor(FixturePanelReader panels)
    {
        var model = RealModel();

        return new AnalystProcessor(
            new PreflightBit(model, new BitCache(4)),
            new InvestigationLoop(model, panels, TimeProvider.System,
                NullLogger<InvestigationLoop>.Instance),
            NullLogger<AnalystProcessor>.Instance);
    }

    /// <summary>Every panel healthy and every counter benign: there is genuinely nothing to report.</summary>
    private static FixturePanelReader QuietWindow() => new FixturePanelReader()
        .Reading("step-outcomes", "ops", """{"Completed":412,"Failed":0,"Cancelled":3}""", samples: 415)
        .Reading("step-failures", "ops", """{"failed":0,"samples":[]}""", samples: 0)
        .Reading("refused-messages", "ops", """{"refusals":0,"samples":[]}""", samples: 0)
        .Reading("run-boundaries", "business", """{"entry":30,"terminal":30,"drainedPolls":0}""", samples: 60)
        .Reading("queue-wait", "ops", """{"meanSeconds":0.013,"max":0.021}""", samples: 91)
        .Reading("processor-liveness", "ops", """{"ready":1.0,"replicas":2}""", samples: 60)
        .Reading("dead-letter-depth", "ops", """{"queues":{"processor-a.dead":0,"processor-b.dead":0}}""", samples: 60);

    /// <summary>
    /// The same window with one unambiguous fault planted: a dead-letter queue holding work, with no
    /// refusals in window. The deployed prompt states that this is reportable and that the age and
    /// ownership of the work are unknown without a believable observation settling them.
    /// </summary>
    private static FixturePanelReader WindowHoldingDiscardedWork() => QuietWindow()
        .Reading("dead-letter-depth", "ops",
            """{"queues":{"processor-a.dead":17,"processor-b.dead":0}}""", samples: 60);

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

        // NoFinding is surfaced as a cancellation: silence is the all-clear, and the exporter is
        // gated on Completed so nothing leaves.
        var quiet = await Record.ExceptionAsync(
            () => processor.AnalyseAsync(Config(DeployedPrompt(), AllPanels), cts.Token));

        Assert.True(
            quiet is CancelledException,
            "a window with no fault must produce no finding, because a monitor that cries wolf twice "
            + $"an hour is one an operator learns to ignore. Got: {quiet?.GetType().Name ?? "a finding"} "
            + $"-- {quiet?.Message}");
    }

    [Fact]
    public async Task APlantedDeadLetterDepthIsFoundAndNamed()
    {
        SkipUnlessEnabled();

        var processor = Processor(WindowHoldingDiscardedWork());
        using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(12));

        var finding = await processor.AnalyseAsync(Config(DeployedPrompt(), AllPanels), cts.Token);

        Assert.NotNull(finding);

        // Cited, not merely mentioned: the finding has to rest on the panel that carries the fault.
        var cited = finding.Evidence.Select(e => e.PanelId)
            .Concat(finding.Trace.Where(t => t.DataReturned).Select(t => t.PanelId))
            .ToList();

        Assert.Contains("dead-letter-depth", cited);

        // And it must not claim the loss is old or foreign: refused-messages under-reports by
        // construction, so zero refusals cannot establish either.
        Assert.DoesNotContain("no refusals in window means the loss is old",
            finding.Narrative, StringComparison.OrdinalIgnoreCase);
    }
}
