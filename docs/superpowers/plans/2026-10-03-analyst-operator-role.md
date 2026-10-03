# The Analyst as Operator -- Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Analyst report every deterministic problem (system or raw data) and every transient one, classified, with the evidence an operator needs to intervene.

**Architecture:** The processor resolves the workflow's run context (start, history limit, deploy markers) from Elasticsearch and renders it, with entry-condition graph layers, into the first message. `read_panel` gains an optional history range clamped to the start; a new ES|QL panel `failure-causes` gives causes, persistence and buckets. Declared expectations in the step payload, finding schema v4 (classified insights), prompt v14 and a three-scenario BIT complete the role.

**Tech Stack:** .NET 8 (C# 12), xUnit v3 (`BaseApi.Tests.exe`), Elasticsearch 9.3.4 ES|QL, Prometheus `query_range`, Redis (L2), Postgres (schema and processor rows), kind cluster `desktop`.

**Spec:** `docs/superpowers/specs/2026-10-03-analyst-operator-role-design.md` (approved 2026-10-03).

## Global Constraints

- History limit = `max(workflow start, now - 30 days)`; `AnalystProcessor.MaxWindow` stays 30 days.
- Start = the latest BaseApi record with `attributes.{OriginalFormat}` = `accepted start for workflow {WorkflowId}` for the target, with no later `accepted stop for workflow {WorkflowId}`. Never the orchestrator's `activated workflow ...` record (it is a deploy marker).
- No start found = history unavailable; the investigation is window-only. Never reach back to "earliest data held".
- History reads return at most **48** points per Prometheus series and at most **48** buckets for `failure-causes`; bucket = `ceil(range / 48)` rounded up to whole minutes, minimum 1 minute.
- Verdicts: Notable = at least one deterministic insight; Drifting = only transient insights; Quiet = none, or only what declared expectations allow; Inconclusive = evidence cannot decide.
- Every insight carries `classification` (deterministic|transient), `domain` (system|data), `severity` (high|low; high iff deterministic), `onset` (string), `evidenceKinds` (at least 2 of: nature, logged-as, persistence, mix, retry, scope, coincidence, conservation).
- Expectation shares count data-domain outcomes only; system problems are never covered.
- Schema rows are frozen: new rows `analyst-config` 2.0.0 and `analyst-finding` 4.0.0; repoint only the `analyst` processor row (`kafka-exporter` has no input schema).
- Every Analyst source edit moves the SourceHash: rebuild, `kind load docker-image ... --name desktop`, repoint the `analyst` row, roll out.
- Test runner: `cd src && dotnet build tests/BaseApi.Tests/BaseApi.Tests.csproj --no-restore -v q`, then `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "*Name"`. Always rebuild before running. Full suite gate: 0 failed, every skip in `Live/`.
- ES|QL reserves `last`, `first` as words in some positions: never name a column `last` or `first`.

## Review Focus

1. **A workflow restarted mid-history** (stop then start): the start must be the latest `accepted start`, and a stop after it means "not running" -- history unavailable. Pinned in Task 1.
2. **History `from` before the start, or in the future, or after the window end**: clamp to `[limit, window.To]`; a `from` at or after `window.To` reads the window. Pinned in Task 4.
3. **A graph with no failure handler and a handler that is also entered by Always**: layers must not invent a sink, and condition 4 counts as accepting Failed. Pinned in Task 3.
4. **A model insight whose verdict contradicts its classifications** (Notable with only transient insights, or Drifting with a deterministic one): rejected and handed back, never published. Pinned in Task 7.
5. **Elasticsearch unreachable while resolving the run context**: the dispatch proceeds window-only with `history unavailable`, it does not fail. Pinned in Task 2.

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `src/Processor.Analyst/Graph/RunContext.cs` (new) | `RunContext` record, `IRunContextSource` | 1 |
| `src/Processor.Analyst/Graph/ElasticRunContextSource.cs` (new) | resolves start, stop, deploy markers via ES\|QL | 1 |
| `src/Processor.Analyst/Graph/RunContextRenderer.cs` (new) | renders `<run-context>` | 2 |
| `src/Processor.Analyst/AnalystProcessor.cs` | appends run context to the briefing; passes history limit to the loop | 2, 4 |
| `src/Processor.Analyst/ProcessorHost.cs` | DI for `ElasticRunContextSource` | 2 |
| `src/Processor.Analyst/Graph/GraphLayers.cs` (new) | per-result layers, handlers, unhandled results, conservation equations | 3 |
| `src/Processor.Analyst/Graph/GraphRenderer.cs` | renders the Layers section | 3 |
| `src/Processor.Analyst/Panels/IPanelReader.cs` + implementers | `history` flag | 4 |
| `src/Processor.Analyst/Tools/ToolCatalog.cs` | `read_panel.from`; v4 `submit_finding` | 4, 7 |
| `src/Processor.Analyst/Loop/InvestigationLoop.cs` | clamps history reads; records ranges; verdict rule | 4, 7 |
| `src/Processor.Analyst/Loop/InvestigationTrace.cs` | per-read range | 4 |
| `src/Processor.Analyst/Panels/PrometheusPanelSource.cs` | 48-point step for history | 4 |
| `src/Processor.Analyst/Panels/PanelRegistry.cs` | `failure-causes` definition | 5 |
| `src/Processor.Analyst/Panels/ElasticPanelSource.cs` | `{{BUCKET}}`, `BuildFailureCauses` | 5 |
| `src/Processor.Analyst/AnalystConfig.cs` | `Expectations` | 6 |
| `src/tests/BaseApi.Tests/Schemas/analyst-config.json` | config schema 2.0.0 | 6 |
| `src/Processor.Analyst/AnalystFinding.cs` | v4 insight and trace fields | 7 |
| `src/tests/BaseApi.Tests/Schemas/analyst-finding.json` | finding schema 4.0.0 | 7 |
| `src/Processor.Analyst/ContractPrompt.cs`, `tools/analyst-prompt-v14.txt` (new) | primer and prompt | 8 |
| `src/Processor.Analyst/Bit/*` | exam, rehearsal scenarios, fixture run context | 9 |
| `docs/rebuild-analyst-monitor-workflow.md`, `docs/offline-steprole-drop.md` | rows, payload, hash | 10 |

Delivery: Tasks 1-3 ship as step 1, Tasks 4-5 as step 2, Tasks 6-10 as step 3 (spec section 7).

---

### Task 1: Resolve the run context from Elasticsearch

**Files:**
- Create: `src/Processor.Analyst/Graph/RunContext.cs`
- Create: `src/Processor.Analyst/Graph/ElasticRunContextSource.cs`
- Test: `src/tests/BaseApi.Tests/Analyst/RunContextSourceTests.cs`

**Interfaces:**
- Consumes: `PanelSourceOptions.ElasticBaseUrl`, `PanelRegistry.ElasticIndex` (`logs-generic.otel-default`).
- Produces:
  - `internal sealed record RunContext(DateTimeOffset? Start, DateTimeOffset? HistoryLimit, IReadOnlyList<DeployMarker> Deploys, string? Unavailable)` with `static RunContext Missing(string why)`.
  - `internal sealed record DeployMarker(DateTimeOffset Minute, int Replicas)`.
  - `internal interface IRunContextSource { Task<RunContext> ReadAsync(Guid workflowId, DateTimeOffset now, CancellationToken ct); }`
  - `internal sealed class ElasticRunContextSource(HttpClient http) : IRunContextSource` with `internal static readonly TimeSpan MaxHistory = TimeSpan.FromDays(30)`.

- [ ] **Step 1: Write the failing tests**

```csharp
using System.Net;
using System.Text;
using Processor.Analyst.Graph;
using Xunit;

namespace BaseApi.Tests.Analyst;

public sealed class RunContextSourceTests
{
    private static readonly Guid W = Guid.Parse("1a56b3ca-e276-4815-87fa-5c2f48ab6dad");
    private static readonly DateTimeOffset Now = new(2026, 10, 3, 7, 25, 0, TimeSpan.Zero);

    private static string Esql(string columns, string values)
        => $$"""{"columns":{{columns}},"values":{{values}}}""";

    private const string StartCols = """[{"name":"last_start","type":"date"},{"name":"last_stop","type":"date"}]""";
    private const string DeployCols = """[{"name":"replicas","type":"long"},{"name":"minute","type":"date"}]""";

    private static ElasticRunContextSource Source(params string[] bodies)
        => new(new HttpClient(new Sequenced(bodies)) { BaseAddress = new Uri("http://elasticsearch:9200") });

    [Fact]
    public async Task TheStartIsTheLatestAcceptedStartAndDeploysFollowIt()
    {
        var ctx = await Source(
            Esql(StartCols, """[["2026-10-02T12:51:47.310Z","2026-10-02T12:51:44.090Z"]]"""),
            Esql(DeployCols, """[[3,"2026-10-02T12:51:00.000Z"],[2,"2026-10-02T14:14:00.000Z"],[3,"2026-10-02T22:43:00.000Z"]]"""))
            .ReadAsync(W, Now, CancellationToken.None);

        Assert.Equal(DateTimeOffset.Parse("2026-10-02T12:51:47.310Z"), ctx.Start);
        Assert.Equal(ctx.Start, ctx.HistoryLimit);
        Assert.Null(ctx.Unavailable);
        // The activation in the start's own minute is the start, not a deploy.
        Assert.Equal(
            [DateTimeOffset.Parse("2026-10-02T14:14:00Z"), DateTimeOffset.Parse("2026-10-02T22:43:00Z")],
            ctx.Deploys.Select(d => d.Minute));
    }

    [Fact]
    public async Task AStopAfterTheLatestStartMeansTheWorkflowIsNotRunning()
    {
        var ctx = await Source(Esql(StartCols, """[["2026-10-02T12:51:47Z","2026-10-02T13:00:00Z"]]"""))
            .ReadAsync(W, Now, CancellationToken.None);

        Assert.Null(ctx.HistoryLimit);
        Assert.Contains("stopped", ctx.Unavailable, StringComparison.Ordinal);
    }

    [Fact]
    public async Task NoStartWithinRetentionMeansHistoryIsUnavailable()
    {
        var ctx = await Source(Esql(StartCols, "[[null,null]]")).ReadAsync(W, Now, CancellationToken.None);

        Assert.Null(ctx.HistoryLimit);
        Assert.Contains("no start", ctx.Unavailable, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AStartOlderThanThirtyDaysIsCappedAtThirtyDays()
    {
        var ctx = await Source(
            Esql(StartCols, """[["2026-08-01T00:00:00Z",null]]"""),
            Esql(DeployCols, "[]"))
            .ReadAsync(W, Now, CancellationToken.None);

        Assert.Equal(Now - ElasticRunContextSource.MaxHistory, ctx.HistoryLimit);
    }

    [Fact]
    public async Task AnUnreachableStoreIsHistoryUnavailableNotAnException()
    {
        var ctx = await new ElasticRunContextSource(
                new HttpClient(new Failing()) { BaseAddress = new Uri("http://elasticsearch:9200") })
            .ReadAsync(W, Now, CancellationToken.None);

        Assert.Null(ctx.HistoryLimit);
        Assert.Contains("could not be read", ctx.Unavailable, StringComparison.Ordinal);
    }

    private sealed class Sequenced(params string[] bodies) : HttpMessageHandler
    {
        private int _next;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(bodies[_next++], Encoding.UTF8, "application/json"),
            });
    }

    private sealed class Failing : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            => throw new HttpRequestException("connection refused");
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src && dotnet build tests/BaseApi.Tests/BaseApi.Tests.csproj --no-restore -v q`
Expected: build FAILS with `CS0246: The type or namespace name 'ElasticRunContextSource' could not be found`.

- [ ] **Step 3: Implement**

`src/Processor.Analyst/Graph/RunContext.cs`:

```csharp
namespace Processor.Analyst.Graph;

/// <summary>A deploy marker: the orchestrator re-activated the workflow in this minute without a start.</summary>
internal sealed record DeployMarker(DateTimeOffset Minute, int Replicas);

/// <summary>
/// Where the target's current run began and how far back evidence may be read. Read by the processor,
/// never by the model, so the limit is known before the first turn (spec U9, D4).
/// </summary>
internal sealed record RunContext(
    DateTimeOffset? Start, DateTimeOffset? HistoryLimit, IReadOnlyList<DeployMarker> Deploys, string? Unavailable)
{
    internal static RunContext Missing(string why) => new(null, null, [], why);
}

internal interface IRunContextSource
{
    Task<RunContext> ReadAsync(Guid workflowId, DateTimeOffset now, CancellationToken ct);
}
```

`src/Processor.Analyst/Graph/ElasticRunContextSource.cs`:

```csharp
using System.Globalization;
using System.Text;
using System.Text.Json;
using Processor.Analyst.Panels;

namespace Processor.Analyst.Graph;

/// <summary>
/// Resolves the run context from BaseApi's start and stop records. The orchestrator's
/// "activated workflow" record is NOT a start: every orchestrator pod restart writes it again, so it
/// is read only as a deploy marker inside the run.
/// </summary>
internal sealed class ElasticRunContextSource(HttpClient http) : IRunContextSource
{
    internal static readonly TimeSpan MaxHistory = TimeSpan.FromDays(30);

    private const string StartTemplate = "accepted start for workflow {WorkflowId}";
    private const string StopTemplate = "accepted stop for workflow {WorkflowId}";

    public async Task<RunContext> ReadAsync(Guid workflowId, DateTimeOffset now, CancellationToken ct)
    {
        try
        {
            var since = (now - MaxHistory).UtcDateTime.ToString("o", CultureInfo.InvariantCulture);
            var row = (await QueryAsync($$"""
                FROM {{PanelRegistry.ElasticIndex}}
                | WHERE @timestamp >= "{{since}}" AND attributes.WorkflowId == "{{workflowId:D}}" AND `attributes.{OriginalFormat}` IN ("{{StartTemplate}}", "{{StopTemplate}}")
                | EVAL is_start = `attributes.{OriginalFormat}` == "{{StartTemplate}}"
                | STATS last_start = MAX(CASE(is_start, @timestamp, NULL)), last_stop = MAX(CASE(NOT is_start, @timestamp, NULL))
                """, ct).ConfigureAwait(false)).SingleOrDefault();

            var start = Date(row, "last_start");
            var stop = Date(row, "last_stop");

            if (start is null)
            {
                return RunContext.Missing($"no start record for the workflow in the last {MaxHistory.TotalDays:F0} days");
            }

            if (stop is { } s && s > start)
            {
                return RunContext.Missing($"the workflow was stopped at {s:O} after its last start");
            }

            var limit = start.Value > now - MaxHistory ? start.Value : now - MaxHistory;
            var startMinute = new DateTimeOffset(start.Value.Year, start.Value.Month, start.Value.Day,
                start.Value.Hour, start.Value.Minute, 0, TimeSpan.Zero);

            var deploys = (await QueryAsync($$"""
                FROM {{PanelRegistry.ElasticIndex}}
                | WHERE @timestamp >= "{{start.Value.UtcDateTime:o}}" AND attributes.WorkflowId == "{{workflowId:D}}" AND `attributes.{OriginalFormat}` LIKE "activated workflow*"
                | STATS replicas = COUNT(*) BY minute = DATE_TRUNC(1 minute, @timestamp)
                | SORT minute
                """, ct).ConfigureAwait(false))
                .Select(r => new DeployMarker(Date(r, "minute")!.Value, (int)r["replicas"].GetInt64()))
                .Where(d => d.Minute > startMinute)
                .ToList();

            return new RunContext(start, limit, deploys, null);
        }
        catch (TaskCanceledException ex) when (!ct.IsCancellationRequested)
        {
            return Unreadable(ex);
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or InvalidOperationException or KeyNotFoundException)
        {
            return Unreadable(ex);
        }
    }

    private static RunContext Unreadable(Exception ex) => RunContext.Missing($"the run context could not be read: {ex.Message}");

    private async Task<IReadOnlyList<Dictionary<string, JsonElement>>> QueryAsync(string esql, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/_query?allow_partial_results=false")
        {
            Content = new StringContent(JsonSerializer.Serialize(new { query = esql }), Encoding.UTF8, "application/json"),
        };
        using var response = await http.SendAsync(request, ct).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false));

        var columns = doc.RootElement.GetProperty("columns").EnumerateArray()
            .Select(c => c.GetProperty("name").GetString()!).ToList();

        return [.. doc.RootElement.GetProperty("values").EnumerateArray().Select(values =>
        {
            var row = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            var i = 0;
            foreach (var cell in values.EnumerateArray())
            {
                row[columns[i++]] = cell.Clone();
            }
            return row;
        })];
    }

    private static DateTimeOffset? Date(IReadOnlyDictionary<string, JsonElement>? row, string column)
        => row is not null && row.TryGetValue(column, out var v) && v.ValueKind == JsonValueKind.String
            ? DateTimeOffset.Parse(v.GetString()!, CultureInfo.InvariantCulture)
            : null;
}
```

- [ ] **Step 4: Run the tests**

Run: build as above, then `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "*RunContextSourceTests"`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/Processor.Analyst/Graph/RunContext.cs src/Processor.Analyst/Graph/ElasticRunContextSource.cs src/tests/BaseApi.Tests/Analyst/RunContextSourceTests.cs
git commit -m "feat(analyst): resolve the run context -- start, history limit, deploy markers -- from ES"
```

---

### Task 2: Render the run context into the first message

**Files:**
- Create: `src/Processor.Analyst/Graph/RunContextRenderer.cs`
- Modify: `src/Processor.Analyst/AnalystProcessor.cs` (constructor; the briefing block near line 257)
- Modify: `src/Processor.Analyst/ProcessorHost.cs` (after the `IWorkflowGraphSource` registration, line ~150)
- Test: `src/tests/BaseApi.Tests/Analyst/RunContextTests.cs`

**Interfaces:**
- Consumes: `RunContext`, `IRunContextSource` (Task 1).
- Produces:
  - `internal static class RunContextRenderer { internal static string Render(RunContext ctx, TimeRange window); }`
  - `AnalystProcessor` gains optional constructor parameter `Graph.IRunContextSource? runs = null` (last position) and a private field holding the resolved `RunContext` per dispatch, passed to the loop in Task 4.
  - test helper `internal sealed class FixedRunContextSource(RunContext ctx) : IRunContextSource` in `RunContextTests.cs`.

- [ ] **Step 1: Write the failing tests**

```csharp
using Microsoft.Extensions.Logging.Abstractions;
using Processor.Analyst;
using Processor.Analyst.Bit;
using Processor.Analyst.Graph;
using Processor.Analyst.Loop;
using Processor.Analyst.Panels;
using BaseApi.Tests.Support;
using Xunit;

namespace BaseApi.Tests.Analyst;

internal sealed class FixedRunContextSource(RunContext ctx) : IRunContextSource
{
    public Task<RunContext> ReadAsync(Guid workflowId, DateTimeOffset now, CancellationToken ct) => Task.FromResult(ctx);
}

public sealed class RunContextTests
{
    private static readonly TimeRange Window = new(
        new DateTimeOffset(2026, 10, 3, 7, 10, 0, TimeSpan.Zero), new DateTimeOffset(2026, 10, 3, 7, 25, 0, TimeSpan.Zero));

    private static readonly RunContext Chain = new(
        DateTimeOffset.Parse("2026-10-02T12:51:47Z"), DateTimeOffset.Parse("2026-10-02T12:51:47Z"),
        [new(DateTimeOffset.Parse("2026-10-02T14:14:00Z"), 2), new(DateTimeOffset.Parse("2026-10-02T22:43:00Z"), 3)], null);

    [Fact]
    public void TheBlockStatesTheLimitAndTheDeploys()
    {
        var text = RunContextRenderer.Render(Chain, Window);

        Assert.StartsWith("<run-context>", text, StringComparison.Ordinal);
        Assert.Contains("Window under judgement: 2026-10-03T07:10:00Z to 2026-10-03T07:25:00Z.", text, StringComparison.Ordinal);
        Assert.Contains("History available back to 2026-10-02T12:51:47Z", text, StringComparison.Ordinal);
        Assert.Contains("14:14Z (2026-10-02), 22:43Z (2026-10-02)", text, StringComparison.Ordinal);
        Assert.EndsWith("</run-context>", text, StringComparison.Ordinal);
    }

    [Fact]
    public void AMissingContextSaysHistoryIsUnavailableAndWhy()
    {
        var text = RunContextRenderer.Render(RunContext.Missing("no start record"), Window);

        Assert.Contains("History is NOT available: no start record.", text, StringComparison.Ordinal);
        Assert.Contains("Judge the window alone.", text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheRunContextRidesInTheFirstMessage()
    {
        var model = new ScriptedModel();
        var processor = new AnalystProcessor(
            new PreflightBit(model, new BitCache(new InMemorySharedState(), "m"),
                options: Microsoft.Extensions.Options.Options.Create(new AnalystBitOptions { Mode = BitMode.StructureOnly })),
            new InvestigationLoop(model, new FixturePanelReader(), TimeProvider.System, NullLogger<InvestigationLoop>.Instance),
            NullLogger<AnalystProcessor>.Instance,
            runs: new FixedRunContextSource(Chain));

        await Assert.ThrowsAnyAsync<Exception>(() => processor.AnalyseAsync(new AnalystConfig(
            Guid.NewGuid(), 15, RunningGraphTests.StagedPrompt, ["step-outcomes"], 12, 100_000, 300), CancellationToken.None));

        Assert.Contains("<run-context>", Assert.Single(model.Received).Transcript[0].Text!, StringComparison.Ordinal);
    }
}
```

If `RunningGraphTests.StagedPrompt` is private, make it `internal static` in that file (it is the five-stage prompt the processor tests already use).

- [ ] **Step 2: Run to verify they fail**

Run: build. Expected: `CS0103: The name 'RunContextRenderer' does not exist` and `no parameter named 'runs'`.

- [ ] **Step 3: Implement**

`src/Processor.Analyst/Graph/RunContextRenderer.cs`:

```csharp
using System.Globalization;
using Processor.Analyst.Panels;

namespace Processor.Analyst.Graph;

/// <summary>The run-context block of the first message: the window, the history limit and the deploys.</summary>
internal static class RunContextRenderer
{
    internal static string Render(RunContext ctx, TimeRange window)
    {
        static string Z(DateTimeOffset t) => t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);

        var lines = new List<string>
        {
            "<run-context>",
            $"Window under judgement: {Z(window.From)} to {Z(window.To)}.",
        };

        if (ctx.HistoryLimit is not { } limit)
        {
            lines.Add($"History is NOT available: {ctx.Unavailable}. Judge the window alone.");
        }
        else
        {
            lines.Add($"History available back to {Z(limit)} (the workflow's current start{(ctx.Start < limit ? ", capped at 30 days" : "")}). "
                + "Nothing before it was produced by this projection; history reads are clamped to it.");
            lines.Add(ctx.Deploys.Count == 0
                ? "No deploys inside that range."
                : "Deploys inside that range (orchestrator restarts; code and counter meanings may change at each): "
                  + string.Join(", ", ctx.Deploys.Select(d => d.Minute.UtcDateTime.ToString("HH:mm'Z' (yyyy-MM-dd)", CultureInfo.InvariantCulture)))
                  + ".");
        }

        lines.Add("</run-context>");
        return string.Join("\n", lines);
    }
}
```

In `AnalystProcessor.cs`, add the constructor parameter after `TimeProvider? clock = null`:

```csharp
    TimeProvider? clock = null,
    Graph.IRunContextSource? runs = null)
```

Replace the briefing block (currently `var briefing = graphs is null ? null : Graph.GraphRenderer.Render(...)`) with:

```csharp
            var graphText = graphs is null
                ? null
                : Graph.GraphRenderer.Render(
                    await graphs.ReadAsync(config.TargetWorkflowId, ct).ConfigureAwait(false));

            // Resolved here, never by the model: the limit must be known before the first turn.
            var runContext = runs is null
                ? Graph.RunContext.Missing("no run-context source is configured")
                : await runs.ReadAsync(config.TargetWorkflowId, to, ct).ConfigureAwait(false);

            var briefing = string.Join("\n\n",
                new[] { graphText, Graph.RunContextRenderer.Render(runContext, range) }.Where(t => t is not null));
```

In `ProcessorHost.cs`, after `builder.Services.AddSingleton<Graph.IWorkflowGraphSource, Graph.L2WorkflowGraphSource>();`:

```csharp
        // Same base address and timeout as the Elastic panel source; one more ES|QL reader.
        builder.Services.AddHttpClient<Graph.ElasticRunContextSource>((sp, client) =>
        {
            client.BaseAddress = new Uri(sp.GetRequiredService<IOptions<Panels.PanelSourceOptions>>().Value.ElasticBaseUrl!);
            client.Timeout = TimeSpan.FromSeconds(20);
        });
        builder.Services.AddSingleton<Graph.IRunContextSource>(sp => sp.GetRequiredService<Graph.ElasticRunContextSource>());
```

Check how `ElasticPanelSource` gets its base address in `ProcessorHost.cs` (line ~200) and copy that exact pattern if it differs.

- [ ] **Step 4: Run the tests**

Run: build, then `--filter-class "*RunContextTests"` and `--filter-class "*RunningGraphTests"` and `--filter-class "*AnalystHostTests"`.
Expected: all pass. `AnalystHostTests` proves the DI graph still resolves.

- [ ] **Step 5: Commit**

```bash
git add src/Processor.Analyst/Graph/RunContextRenderer.cs src/Processor.Analyst/AnalystProcessor.cs src/Processor.Analyst/ProcessorHost.cs src/tests/BaseApi.Tests/Analyst/RunContextTests.cs src/tests/BaseApi.Tests/Analyst/RunningGraphTests.cs
git commit -m "feat(analyst): the run context rides in the first message"
```

---

### Task 3: Graph layers by entry condition

**Files:**
- Create: `src/Processor.Analyst/Graph/GraphLayers.cs`
- Modify: `src/Processor.Analyst/Graph/GraphRenderer.cs` (append a Layers section before `</running-graph>`)
- Test: `src/tests/BaseApi.Tests/Analyst/GraphLayersTests.cs`

**Interfaces:**
- Consumes: `RunningGraph`, `StepL1`, `GraphRenderer.Accepts(int, StepResult)`.
- Produces:
  - `internal sealed record Handler(Guid StepId, StepResult Takes, IReadOnlyList<Guid> FanIn)`
  - `internal sealed record UnhandledResult(Guid StepId, StepResult Result)`
  - `internal sealed record GraphLayers(IReadOnlyList<Handler> Handlers, IReadOnlyList<UnhandledResult> Unhandled, IReadOnlyList<string> Conservation)` with `static GraphLayers Of(RunningGraph graph, Func<Guid, string> name)`.

- [ ] **Step 1: Write the failing tests**

```csharp
using Messaging.Contracts;
using Processor.Analyst.Graph;
using Xunit;

namespace BaseApi.Tests.Analyst;

public sealed class GraphLayersTests
{
    private static readonly RunningGraph Chain = ReplayFixtures.Graph("endless-feed-edges");

    private static string Name(RunningGraph g, Guid id) => g.Names.TryGetValue(id, out var n) ? n.Split('_')[0] : id.ToString("D");

    [Fact]
    public void TheChainHasOneFailureSinkWithFanInEight()
    {
        var layers = GraphLayers.Of(Chain, id => Name(Chain, id));

        var sink = Assert.Single(layers.Handlers);
        Assert.Equal(StepResult.Failed, sink.Takes);
        Assert.Equal("record-outcome", Name(Chain, sink.StepId));
        Assert.Equal(8, sink.FanIn.Count);
    }

    [Fact]
    public void TheSinksOwnFailureAndEveryCancellationAreUnhandled()
    {
        var layers = GraphLayers.Of(Chain, id => Name(Chain, id));

        Assert.Contains(layers.Unhandled, u => Name(Chain, u.StepId) == "record-outcome" && u.Result == StepResult.Failed);
        Assert.Contains(layers.Unhandled, u => Name(Chain, u.StepId) == "export-outcome" && u.Result == StepResult.Failed);
        Assert.Contains(layers.Unhandled, u => Name(Chain, u.StepId) == "split-importer" && u.Result == StepResult.Cancelled);
    }

    [Fact]
    public void ConservationEquatesTheFailuresInWithTheSinkPath()
    {
        var eq = Assert.Single(GraphLayers.Of(Chain, id => Name(Chain, id)).Conservation);

        Assert.StartsWith("Failed outcomes of the 8 steps routing Failed to record-outcome", eq, StringComparison.Ordinal);
        Assert.Contains("= outcomes of record-outcome", eq, StringComparison.Ordinal);
        Assert.Contains("= outcomes of export-outcome", eq, StringComparison.Ordinal);
    }

    [Fact]
    public void AGraphWithNoHandlerHasNoSinkAndSaysSo()
    {
        var a = Guid.NewGuid(); var b = Guid.NewGuid();
        var g = new RunningGraph(Guid.NewGuid(), true, "0 * * * * *", [a],
            [new StepL1(a, 4, Guid.NewGuid(), "{}", [b]), new StepL1(b, 1, Guid.NewGuid(), "{}", [])],
            new Dictionary<Guid, string>());

        var layers = GraphLayers.Of(g, id => id.ToString("D")[..4]);

        Assert.Empty(layers.Handlers);
        Assert.Empty(layers.Conservation);
        Assert.Contains("failures are recorded only in logs",
            GraphRenderer.Render(GraphBriefing.Of(g)), StringComparison.Ordinal);
    }

    [Fact]
    public void AnAlwaysSuccessorCountsAsAcceptingFailedButIsNotAHandler()
    {
        // Condition 4 (Always) takes Failed, so Failed is handled -- but an Always step is part of the
        // work path, not a failure handler, and must not be reported as a sink.
        var a = Guid.NewGuid(); var b = Guid.NewGuid();
        var g = new RunningGraph(Guid.NewGuid(), true, "0 * * * * *", [a],
            [new StepL1(a, 4, Guid.NewGuid(), "{}", [b]), new StepL1(b, 4, Guid.NewGuid(), "{}", [])],
            new Dictionary<Guid, string>());

        var layers = GraphLayers.Of(g, id => id.ToString("D")[..4]);

        Assert.Empty(layers.Handlers);
        Assert.DoesNotContain(layers.Unhandled, u => u.StepId == a);
    }

    [Fact]
    public void TheBriefingCarriesTheLayers()
    {
        var text = GraphRenderer.Render(GraphBriefing.Of(Chain));

        Assert.Contains("Layers (computed from the entry conditions):", text, StringComparison.Ordinal);
        Assert.Contains("Failure handler:", text, StringComparison.Ordinal);
        Assert.Contains("Check: Failed outcomes of the 8 steps", text, StringComparison.Ordinal);
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: build. Expected: `CS0246: The type or namespace name 'GraphLayers' could not be found`.

- [ ] **Step 3: Implement**

`src/Processor.Analyst/Graph/GraphLayers.cs`:

```csharp
using Messaging.Contracts;

namespace Processor.Analyst.Graph;

internal sealed record Handler(Guid StepId, StepResult Takes, IReadOnlyList<Guid> FanIn);

internal sealed record UnhandledResult(Guid StepId, StepResult Result);

/// <summary>
/// The graph read by entry condition (spec 4.2, D5): steps entered on Failed or Cancelled are
/// handlers, results no successor takes are unhandled, and every handler yields a conservation
/// equation the agent must check. Computed once, in code -- never left to the model.
/// </summary>
internal sealed record GraphLayers(
    IReadOnlyList<Handler> Handlers, IReadOnlyList<UnhandledResult> Unhandled, IReadOnlyList<string> Conservation)
{
    private static readonly StepResult[] Results = [StepResult.Completed, StepResult.Failed, StepResult.Cancelled];

    internal static GraphLayers Of(RunningGraph graph, Func<Guid, string> name)
    {
        var steps = graph.Steps.ToDictionary(s => s.StepId);

        var handlers = graph.Steps
            .Where(s => s.EntryCondition is (int)StepResult.Failed or (int)StepResult.Cancelled)
            .Select(s => new Handler(
                s.StepId,
                (StepResult)s.EntryCondition,
                [.. graph.Steps.Where(p => (p.NextStepIds ?? []).Contains(s.StepId)).Select(p => p.StepId)]))
            .ToList();

        var unhandled = graph.Steps
            .SelectMany(s => Results
                .Where(r => !(s.NextStepIds ?? []).Any(n => steps.TryGetValue(n, out var next) && GraphRenderer.Accepts(next.EntryCondition, r)))
                .Select(r => new UnhandledResult(s.StepId, r)))
            .ToList();

        var conservation = handlers
            .Where(h => h.Takes == StepResult.Failed && h.FanIn.Count > 0)
            .Select(h =>
            {
                var path = new List<Guid> { h.StepId };
                // Follow the handler's Completed route while it is a single successor.
                var cursor = steps[h.StepId];
                while ((cursor.NextStepIds ?? []).Where(n => steps.TryGetValue(n, out var x) && GraphRenderer.Accepts(x.EntryCondition, StepResult.Completed)).ToList() is [var only]
                       && !path.Contains(only))
                {
                    path.Add(only);
                    cursor = steps[only];
                }

                return $"Failed outcomes of the {h.FanIn.Count} steps routing Failed to {name(h.StepId)} "
                     + string.Concat(path.Select(p => $"= outcomes of {name(p)} "))
                     + "(a shortfall means the failure handling itself is losing failures)";
            })
            .ToList();

        return new GraphLayers(handlers, unhandled, conservation);
    }
}
```

In `GraphRenderer.Render`, before `return text.Append("</running-graph>").ToString();`, add:

```csharp
        var layers = GraphLayers.Of(graph, id => labels.TryGetValue(id, out var l) ? $"{l} {Name(id)}" : Name(id));
        text.AppendLine()
            .AppendLine("Layers (computed from the entry conditions):");

        if (layers.Handlers.Count == 0)
        {
            text.AppendLine("  No step is entered on Failed or Cancelled: failures are recorded only in logs, "
                + "and each one ends at the step that failed.");
        }

        foreach (var h in layers.Handlers)
        {
            text.AppendLine($"  Failure handler: {Ref(h.StepId)} {Name(h.StepId)} takes {h.Takes} from {h.FanIn.Count} step(s): "
                + string.Join(", ", h.FanIn.Select(Ref)) + ".");
        }

        foreach (var group in layers.Unhandled.GroupBy(u => u.Result))
        {
            text.AppendLine($"  {group.Key} is handled by nothing at: " + string.Join(", ", group.Select(u => Ref(u.StepId))) + ".");
        }

        foreach (var eq in layers.Conservation)
        {
            text.AppendLine($"  Check: {eq}");
        }
```

- [ ] **Step 4: Run the tests**

Run: build, then `--filter-class "*GraphLayersTests"` and `--filter-class "*RunningGraphTests"`.
Expected: all pass. `RunningGraphTests` writes the rendered briefing to `TestResults/running-graph-briefing.txt`; read it once to confirm the Layers section reads naturally.

- [ ] **Step 5: Commit**

```bash
git add src/Processor.Analyst/Graph/GraphLayers.cs src/Processor.Analyst/Graph/GraphRenderer.cs src/tests/BaseApi.Tests/Analyst/GraphLayersTests.cs
git commit -m "feat(analyst): graph layers by entry condition -- handlers, unhandled results, conservation"
```

---

### Task 4: History reads on `read_panel`

**Files:**
- Modify: `src/Processor.Analyst/Panels/IPanelReader.cs`, `LivePanelReader.cs`, `PrometheusPanelSource.cs`, `src/Processor.Analyst/Bit/RehearsalPanels.cs`, `src/tests/BaseApi.Tests/Analyst/FixturePanelReader.cs`
- Modify: `src/Processor.Analyst/Tools/ToolCatalog.cs` (the `read_panel` spec)
- Modify: `src/Processor.Analyst/Loop/InvestigationLoop.cs` (`RunAsync` signature; the `ReadPanel` case near line 201)
- Modify: `src/Processor.Analyst/Loop/InvestigationTrace.cs`
- Modify: `src/Processor.Analyst/AnalystProcessor.cs` (pass `runContext.HistoryLimit` to the loop)
- Test: `src/tests/BaseApi.Tests/Analyst/HistoryReadTests.cs`

**Interfaces:**
- Consumes: `RunContext.HistoryLimit` (Task 1/2).
- Produces:
  - `IPanelReader.ReadAsync(string panelId, Guid targetWorkflowId, TimeRange range, bool history, CancellationToken ct)` -- every implementer takes `history`.
  - `PrometheusPanelSource.ComputeStep(TimeRange range, bool history = false)`; `internal const int HistoryPoints = 48;`
  - `InvestigationLoop.RunAsync(string system, AnalystConfig config, TimeRange window, string promptHash, CancellationToken ct, string? briefing = null, DateTimeOffset? historyLimit = null)`
  - `internal static TimeRange InvestigationLoop.ClampHistory(TimeRange window, DateTimeOffset? limit, DateTimeOffset? from)` -- returns `window` when `from` is null, `limit` is null, or `from >= window.To`; else `new(max(from, limit), window.To)`.
  - `InvestigationTrace.Ranges` : `IReadOnlyList<TimeRange?>` parallel to `Entries` (null = window read). (Serialized into the finding in Task 7.)

- [ ] **Step 1: Write the failing tests**

```csharp
using Processor.Analyst.Loop;
using Processor.Analyst.Panels;
using Processor.Analyst.Tools;
using Xunit;

namespace BaseApi.Tests.Analyst;

public sealed class HistoryReadTests
{
    private static readonly TimeRange Window = new(
        new DateTimeOffset(2026, 10, 3, 7, 10, 0, TimeSpan.Zero), new DateTimeOffset(2026, 10, 3, 7, 25, 0, TimeSpan.Zero));
    private static readonly DateTimeOffset Limit = new(2026, 10, 2, 12, 51, 47, TimeSpan.Zero);

    [Fact]
    public void NoFromReadsTheWindow()
        => Assert.Equal(Window, InvestigationLoop.ClampHistory(Window, Limit, null));

    [Fact]
    public void AFromBeforeTheLimitIsClampedToTheLimit()
        => Assert.Equal(new TimeRange(Limit, Window.To),
            InvestigationLoop.ClampHistory(Window, Limit, Limit.AddDays(-3)));

    [Fact]
    public void AFromInsideTheRunIsKept()
    {
        var from = new DateTimeOffset(2026, 10, 3, 6, 0, 0, TimeSpan.Zero);
        Assert.Equal(new TimeRange(from, Window.To), InvestigationLoop.ClampHistory(Window, Limit, from));
    }

    [Fact]
    public void AFromAtOrAfterTheWindowEndReadsTheWindow()
        => Assert.Equal(Window, InvestigationLoop.ClampHistory(Window, Limit, Window.To.AddHours(1)));

    [Fact]
    public void WithNoLimitThereIsNoHistory()
        => Assert.Equal(Window, InvestigationLoop.ClampHistory(Window, null, Limit));

    [Fact]
    public void AHistoryRangeUsesAtMostFortyEightPrometheusPoints()
    {
        var range = new TimeRange(Limit, Window.To);
        var step = PrometheusPanelSource.ComputeStep(range, history: true);

        Assert.True(range.To - range.From <= step * PrometheusPanelSource.HistoryPoints);
    }

    [Fact]
    public void ReadPanelOffersAnOptionalFrom()
    {
        var spec = ToolCatalog.Build([new PanelDescriptor("step-outcomes", "business", "d")])
            .Single(t => t.Name == ToolNames.ReadPanel);

        Assert.Contains("\"from\":{\"type\":\"string\",\"format\":\"date-time\"}", spec.InputSchemaJson.Replace(" ", ""), StringComparison.Ordinal);
        Assert.Contains("\"required\":[\"panelId\"]", spec.InputSchemaJson.Replace(" ", ""), StringComparison.Ordinal);
    }

    [Fact]
    public async Task AHistoryReadIsServedTheClampedRangeAndTraced()
    {
        var reader = new FixturePanelReader().Reading("step-outcomes", "business", "{}", samples: 5);
        var model = new ScriptedModel(
            ModelReply.Of(ScriptedModel.Call(ToolNamesForTest.ReadPanel, new { panelId = "step-outcomes", from = "2026-09-01T00:00:00Z" })),
            ModelReply.Of(ScriptedModel.Call("report_no_finding", new { reason = "x" })));

        await Assert.ThrowsAnyAsync<Exception>(() => new InvestigationLoop(model, reader, TimeProvider.System,
                Microsoft.Extensions.Logging.Abstractions.NullLogger<InvestigationLoop>.Instance)
            .RunAsync("sys", new Processor.Analyst.AnalystConfig(Guid.NewGuid(), 15, "p", ["step-outcomes"], 12, 100_000, 300),
                Window, "h", CancellationToken.None, historyLimit: Limit));

        var (range, history) = Assert.Single(reader.Requests);
        Assert.Equal(new TimeRange(Limit, Window.To), range);
        Assert.True(history);
    }
}
```

`FixturePanelReader` gains `internal List<(TimeRange Range, bool History)> Requests { get; } = [];`, appended in `ReadAsync`. (The `report_no_finding` without stages throws `AnalysisImpossibleException`; the test only needs the read to have happened.)

- [ ] **Step 2: Run to verify they fail**

Run: build. Expected: `CS0117: 'InvestigationLoop' does not contain a definition for 'ClampHistory'` and the `ComputeStep` overload error.

- [ ] **Step 3: Implement**

`IPanelReader.cs`: change the method to

```csharp
    /// <param name="history">A since-start read rather than the window: sources shape the result to
    /// fit the token budget (spec 4.3).</param>
    Task<PanelReading> ReadAsync(string panelId, Guid targetWorkflowId, TimeRange range, bool history, CancellationToken ct);
```

`LivePanelReader.ReadAsync` takes `bool history` and passes it only to `prometheus.ReadAsync(definition, targetWorkflowId, range, history, ct)`. The Elastic `_search` panels return their totals over the history range unchanged, and the ES|QL panels derive their bucket from the range (Task 5): the time shape of failures over a history range is `failure-causes`' job, so no histogram is added to `step-outcomes`, `step-failures` or `refused-messages` (spec 4.3, amended).

`PrometheusPanelSource.cs`:

```csharp
    /// <summary>Points per series on a history read (spec 4.3).</summary>
    internal const int HistoryPoints = 48;

    internal static TimeSpan ComputeStep(TimeRange range, bool history = false)
    {
        var duration = range.To - range.From;
        var points = history ? HistoryPoints : MaxPointsPerSeries;
        if (duration <= TimeSpan.Zero)
        {
            return MinStep;
        }

        var evenStep = TimeSpan.FromSeconds(Math.Ceiling(duration.TotalSeconds / points));
        return evenStep > MinStep ? evenStep : MinStep;
    }
```

and its `ReadAsync` gains `bool history` and calls `ComputeStep(range, history)`. Keep the existing early-return for a non-positive duration exactly as it is today.

`ToolCatalog.cs`, the `read_panel` spec:

```csharp
            new ToolSpec(ToolNames.ReadPanel,
                "Read one panel over the analysis window, or -- with 'from' -- from that instant to the window's end. "
                + "Use 'from' only for a hypothesis a window reading made suspicious; it is clamped to the history "
                + "limit stated in the run context. The result carries trust flags: a series that was absent, a "
                + "window only partly covered, or a 'no data' that could not be told apart from 'no problem'. Treat "
                + "those as facts about the evidence, not about the system.",
                $$"""
                {"type":"object",
                 "properties":{"panelId":{"type":"string","enum":
                   {{ids}}
                 },
                 "from":{"type":"string","format":"date-time"} },
                 "required":["panelId"],
                 "additionalProperties":false}
                """),
```

`InvestigationLoop.cs`: add `DateTimeOffset? historyLimit = null` as the last parameter of `RunAsync`, keep it in a field for the dispatch, and change the `ReadPanel` case:

```csharp
            case ToolNames.ReadPanel:
                var panelId = call.Input.GetProperty("panelId").GetString()!;
                DateTimeOffset? from = call.Input.TryGetProperty("from", out var f)
                    && DateTimeOffset.TryParse(f.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed)
                    ? parsed : null;
                var range = ClampHistory(window, historyLimit, from);
                var history = range != window;
                PanelReading reading;
                try
                {
                    reading = await panels.ReadAsync(panelId, config.TargetWorkflowId, range, history, ct).ConfigureAwait(false);
                }
                catch (PanelUnavailableException ex)
                {
                    throw new AnalysisImpossibleException(ex.Message, ex);
                }

                trace.Record(panelId, reading.SampleCount > 0, reading.SampleCount, history ? range : null);
                return new ModelToolResult(call.CallId,
                    JsonSerializer.Serialize(new { served = new { from = range.From, to = range.To, history }, reading }),
                    IsError: false);
```

and the helper:

```csharp
    /// <summary>
    /// The range a read is served: the window, unless a 'from' inside the run asks for more. Clamped in
    /// code so no read can reach past the workflow's start, whatever the model asks for (spec U8).
    /// </summary>
    internal static TimeRange ClampHistory(TimeRange window, DateTimeOffset? limit, DateTimeOffset? from)
    {
        if (from is not { } f || limit is not { } l || f >= window.To)
        {
            return window;
        }

        return new TimeRange(f > l ? f : l, window.To);
    }
```

`InvestigationTrace.cs`:

```csharp
    private readonly List<TimeRange?> _ranges = [];

    /// <summary>Parallel to <see cref="Entries"/>: the history range served, or null for a window read.</summary>
    internal IReadOnlyList<TimeRange?> Ranges => _ranges;

    internal void Record(string panelId, bool dataReturned, int samples = 0, TimeRange? history = null)
    {
        _entries.Add(new TraceEntry(_entries.Count + 1, panelId, dataReturned));
        _ranges.Add(history);
        SamplesRead += samples;
    }
```

`StageAssertions` already counts every trace entry of a panel as a read of it, so a history read is a read (spec 4.3) with no change; add one assertion test in `StageAssertionsTests`:

```csharp
    [Fact]
    public void AHistoryReadCountsAsReadingThePanel()
    {
        var trace = new InvestigationTrace();
        trace.Record("step-failures", true, 5, new TimeRange(DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch.AddHours(1)));

        Assert.Contains("step-failures", trace.PanelsRead);
    }
```

`AnalystProcessor.cs`: pass the limit, `... PromptHash.Of(config.Prompt), ct, briefing, runContext.HistoryLimit)`.

`RehearsalPanels.ReadAsync` and `FixturePanelReader.ReadAsync` take `bool history`; `FixturePanelReader` records `(range, history)` in `Requests`. Fix every other `ReadAsync(` call site the compiler reports (tests included) by passing `history: false`.

- [ ] **Step 4: Run the tests**

Run: build; `--filter-class "*HistoryReadTests"`, `--filter-class "*InvestigationLoopTests"`, `--filter-class "*StageAssertionsTests"`, `--filter-class "*PanelTrustTests"`, `--filter-class "*ToolCatalogTests"`.
Expected: all pass. If a `ToolCatalogTests` case pins the old `read_panel` description, update the expected text to the new one.

- [ ] **Step 5: Commit**

```bash
git add -u src
git add src/tests/BaseApi.Tests/Analyst/HistoryReadTests.cs
git commit -m "feat(analyst): read_panel takes an optional from, clamped to the workflow's start"
```

---

### Task 5: The `failure-causes` panel

**Files:**
- Modify: `src/Processor.Analyst/Panels/PanelRegistry.cs` (new definition after `run-boundaries`)
- Modify: `src/Processor.Analyst/Panels/ElasticPanelSource.cs` (`Substitute` gains `{{BUCKET}}`; ES|QL dispatch gains `"failure-causes" => BuildFailureCauses(...)`)
- Create fixtures: `src/tests/BaseApi.Tests/Analyst/Fixtures/esql-causes.json`, `esql-cause-buckets.json`
- Test: `src/tests/BaseApi.Tests/Analyst/PanelTrustTests.cs` (append), `PanelRegistryTests.cs` (append)

**Interfaces:**
- Consumes: `ElasticPanelSource.ReadEsqlAsync`, `SingleRow`/`Long`/`Text`/`Date` helpers, `ParseEsqlRows`.
- Produces:
  - panel id `failure-causes`, `PanelKind.Esql`, two statements (causes, buckets).
  - `internal static string ElasticPanelSource.BucketFor(TimeRange range)` -> ES|QL duration literal, e.g. `"1 minute"`, `"28 minutes"`.
  - reading value: `{"bucket":"28 minutes","causes":[{"step":..,"logged":"author-reported|faulted|other","cause":..,"count":n,"firstSeen":..,"lastSeen":..}],"buckets":[{"start":..,"imported":n,"failed":n,"cancelled":n,"failedShare":0.6}]}`.

- [ ] **Step 1: Write the fixtures and failing tests**

`Fixtures/esql-causes.json` (from the live 2026-10-03 07:10-07:25 window):

```json
{"columns":[{"name":"count","type":"long"},{"name":"first_seen","type":"date"},{"name":"last_seen","type":"date"},{"name":"attributes.StepName","type":"keyword"},{"name":"logged","type":"keyword"},{"name":"cause","type":"keyword"}],
 "values":[
  [8,"2026-10-03T07:20:00.494Z","2026-10-03T07:24:00.480Z","split-archiveexpander_1.0.0-b5a8-f6b2ce5722b1","author-reported","the author reported the step failed: extracting sim-<n>-corrupt.zip failed: the file is named '.zip' and its leading bytes are no archive this processor knows"],
  [8,"2026-10-03T07:20:00.318Z","2026-10-03T07:24:00.416Z","split-filefetcher_1.0.0-9d20-ab0a6d3fd48f","author-reported","the author reported the step failed: file <path> rejected: extension '.dat' is not in the allowed list (.zip)"],
  [8,"2026-10-03T07:20:00.695Z","2026-10-03T07:24:00.544Z","sk-normalizer-sample_1.0.0-b790-2eeb754ed4fd","author-reported","the author reported the step failed: normalizing sim-<n>-triple.zip failed: item 'track<n>': an Acme item is exactly the .wav and the .json, and this one also holds track<n>.txt"]]}
```

`Fixtures/esql-cause-buckets.json`:

```json
{"columns":[{"name":"imported","type":"long"},{"name":"failed","type":"long"},{"name":"cancelled","type":"long"},{"name":"bucket","type":"date"}],
 "values":[[0,0,5,"2026-10-03T07:10:00.000Z"],[0,0,5,"2026-10-03T07:15:00.000Z"],[40,24,8,"2026-10-03T07:20:00.000Z"]]}
```

Append to `PanelTrustTests.cs`:

```csharp
    [Fact]
    public async Task FailureCausesCarryEachCauseAndTheSharePerBucket()
    {
        var reading = await ElasticSource(Fixture("esql-causes.json"), Fixture("esql-cause-buckets.json"))
            .ReadEsqlAsync(Def("failure-causes"), W, Range, CancellationToken.None);

        using var value = JsonDocument.Parse(reading.ValueJson);
        var causes = value.RootElement.GetProperty("causes").EnumerateArray().ToList();
        Assert.Equal(3, causes.Count);
        Assert.All(causes, c => Assert.Equal("author-reported", c.GetProperty("logged").GetString()));
        Assert.Equal(24, causes.Sum(c => c.GetProperty("count").GetInt64()));

        var last = value.RootElement.GetProperty("buckets").EnumerateArray().Last();
        Assert.Equal(0.6, last.GetProperty("failedShare").GetDouble(), 3);
        Assert.Equal(24, reading.SampleCount);
        Assert.True(reading.Trust.SeriesPresent);
    }

    [Fact]
    public async Task NoFailuresIsATrustedZeroWhenTheWorkflowLoggedOutcomes()
    {
        var reading = await ElasticSource(
                """{"columns":[{"name":"count","type":"long"}],"values":[]}""",
                Fixture("esql-cause-buckets.json"))
            .ReadEsqlAsync(Def("failure-causes"), W, Range, CancellationToken.None);

        Assert.Equal(0, reading.SampleCount);
        Assert.True(reading.Trust.NoDataDistinguishable);
    }

    [Theory]
    [InlineData(15, "1 minute")]
    [InlineData(48 * 60, "60 minutes")]
    [InlineData(1100, "23 minutes")]
    public void TheBucketKeepsAHistoryReadUnderFortyEightBuckets(int minutes, string expected)
        => Assert.Equal(expected, ElasticPanelSource.BucketFor(new TimeRange(Range.From, Range.From.AddMinutes(minutes))));
```

Append to `PanelRegistryTests.cs`:

```csharp
    [Fact]
    public void FailureCausesClassifiesHowEachFailureWasLogged()
    {
        var q = PanelRegistry.All.Single(p => p.PanelId == "failure-causes").Query;

        Assert.Contains("\"the author reported the step failed*\", \"author-reported\"", q, StringComparison.Ordinal);
        Assert.Contains("\"the transform faulted*\", \"faulted\"", q, StringComparison.Ordinal);
        Assert.Contains("DATE_TRUNC({{BUCKET}}, @timestamp)", q, StringComparison.Ordinal);
        Assert.DoesNotContain(" last ", q, StringComparison.Ordinal);
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: build, then `--filter-class "*PanelTrustTests"`.
Expected: FAIL with `Sequence contains no matching element` (no `failure-causes` definition).

- [ ] **Step 3: Implement**

`PanelRegistry.cs`, new entry:

```csharp
        // No operator board counterpart yet: the Kibana board shows step outcomes, not causes over time.
        // When one is added, keep it in step with this query (the maintenance rule above).
        new PanelDefinition(
            PanelId: "failure-causes",
            Layer: "business",
            Description:
                "Every distinct failure cause for the target workflow over the range: the step, how it was " +
                "logged (author-reported = the step's own code rejected the item; faulted = an unexpected " +
                "exception; other), the cause text with paths, names, ids and numbers replaced by " +
                "placeholders, its count, and when it was first and last seen. Plus, per time bucket, the " +
                "items imported, failed and cancelled and the failed share. This is the panel for telling a " +
                "deterministic problem from a transient one: persistence, onset, mix and nature. bucket " +
                "names the bucket width; a history read uses wider buckets so the range fits.",
            Kind: PanelKind.Esql,
            Query:
                """
                FROM logs-generic.otel-default
                | WHERE @timestamp >= "{{FROM}}" AND @timestamp <= "{{TO}}" AND attributes.WorkflowId == "{{WORKFLOW}}" AND attributes.Result == "Failed" AND NOT resource.attributes.service.name == "orchestrator"
                | EVAL logged = CASE(`attributes.{OriginalFormat}` LIKE "the author reported the step failed*", "author-reported", `attributes.{OriginalFormat}` LIKE "the transform faulted*", "faulted", "other")
                | EVAL cause = REPLACE(REPLACE(REPLACE(TO_STRING(body.text), "[0-9a-fA-F]{8}-[0-9a-fA-F-]{27}", "<id>"), "/[^ ]+", "<path>"), "[0-9]+", "<n>")
                | STATS count = COUNT(*), first_seen = MIN(@timestamp), last_seen = MAX(@timestamp) BY attributes.StepName, logged, cause
                | SORT count DESC
                | LIMIT 50
                ---
                FROM logs-generic.otel-default
                | WHERE @timestamp >= "{{FROM}}" AND @timestamp <= "{{TO}}" AND attributes.WorkflowId == "{{WORKFLOW}}" AND attributes.Result IS NOT NULL AND NOT resource.attributes.service.name == "orchestrator"
                | EVAL imported = CASE(attributes.StepName LIKE "*importer*" AND attributes.Result == "Completed", 1, 0), failed = CASE(attributes.Result == "Failed", 1, 0), cancelled = CASE(attributes.Result == "Cancelled", 1, 0)
                | STATS imported = SUM(imported), failed = SUM(failed), cancelled = SUM(cancelled) BY bucket = DATE_TRUNC({{BUCKET}}, @timestamp)
                | SORT bucket
                """),
```

`ElasticPanelSource.cs`:

```csharp
    /// <summary>The bucket width that keeps a range under 48 buckets, never below a minute (spec 4.3).</summary>
    internal static string BucketFor(TimeRange range)
    {
        var minutes = (int)Math.Max(1, Math.Ceiling((range.To - range.From).TotalMinutes / 48));
        return minutes == 1 ? "1 minute" : $"{minutes} minutes";
    }

    private static string Substitute(string query, Guid targetWorkflowId, TimeRange range) => query
        .Replace("{{FROM}}", range.From.UtcDateTime.ToString("o"), StringComparison.Ordinal)
        .Replace("{{TO}}", range.To.UtcDateTime.ToString("o"), StringComparison.Ordinal)
        .Replace("{{WORKFLOW}}", targetWorkflowId.ToString("D"), StringComparison.Ordinal)
        .Replace("{{BUCKET}}", BucketFor(range), StringComparison.Ordinal);
```

Dispatch line: `"failure-causes" => BuildFailureCauses(definition, range, tables),` and:

```csharp
    private static PanelReading BuildFailureCauses(
        PanelDefinition definition, TimeRange range,
        IReadOnlyList<IReadOnlyList<IReadOnlyDictionary<string, JsonElement>>> tables)
    {
        var id = definition.PanelId;
        if (tables.Count != 2)
        {
            throw new PanelUnavailableException(id, $"expected 2 ES|QL statements (causes, buckets), got {tables.Count}");
        }

        var causes = tables[0].Select(r => new
        {
            step = Text(id, r, "attributes.StepName"),
            logged = Text(id, r, "logged"),
            cause = Text(id, r, "cause"),
            count = Long(id, r, "count"),
            firstSeen = Date(id, r, "first_seen"),
            lastSeen = Date(id, r, "last_seen"),
        }).ToList();

        var buckets = tables[1].Select(r =>
        {
            var imported = Long(id, r, "imported");
            var failed = Long(id, r, "failed");
            return new
            {
                start = Date(id, r, "bucket"),
                imported,
                failed,
                cancelled = Long(id, r, "cancelled"),
                failedShare = imported == 0 ? 0.0 : Math.Round((double)failed / imported, 3),
            };
        }).ToList();

        var valueJson = JsonSerializer.Serialize(new { bucket = BucketFor(range), causes, buckets });
        var failures = (int)causes.Sum(c => c.count);
        var reporting = buckets.Count > 0;

        return new PanelReading(id, definition.Layer, valueJson, SampleCount: failures,
            new PanelTrust(SeriesPresent: reporting, WindowFullyCovered: reporting, NoDataDistinguishable: reporting));
    }
```

- [ ] **Step 4: Run the tests**

Run: build; `--filter-class "*PanelTrustTests"`, `--filter-class "*PanelRegistryTests"`.
Expected: all pass. Then run the panel once against live ES to check the real statements still parse:
`curl -s localhost:19200/_query -H 'Content-Type: application/json' -d '{"query":"<statement 1 with FROM/TO/WORKFLOW/BUCKET filled>"}'` -- expected: a `columns`/`values` response, no error.

- [ ] **Step 5: Commit**

```bash
git add src/Processor.Analyst/Panels/PanelRegistry.cs src/Processor.Analyst/Panels/ElasticPanelSource.cs src/tests/BaseApi.Tests/Analyst/PanelTrustTests.cs src/tests/BaseApi.Tests/Analyst/PanelRegistryTests.cs src/tests/BaseApi.Tests/Analyst/Fixtures/esql-causes.json src/tests/BaseApi.Tests/Analyst/Fixtures/esql-cause-buckets.json
git commit -m "feat(analyst): failure-causes panel -- causes by how they were logged, persistence and share per bucket"
```

**Delivery step 2 ends here.** Deploy (Task 10, steps 1-4 only, no schema rows) and add `failure-causes` to the assignment's `panelSet` if you want it live before step 3.

---

### Task 6: Declared expectations

**Files:**
- Modify: `src/Processor.Analyst/AnalystConfig.cs`
- Modify: `src/tests/BaseApi.Tests/Schemas/analyst-config.json` (becomes 2.0.0)
- Modify: `src/Processor.Analyst/Graph/RunContextRenderer.cs` (renders the expectations)
- Modify: `src/Processor.Analyst/AnalystProcessor.cs` (passes `config.Expectations` to the renderer)
- Test: `src/tests/BaseApi.Tests/Analyst/AnalystConfigSchemaTests.cs` (existing conformance test), `RunContextTests.cs` (append)

**Interfaces:**
- Produces:
  - `public sealed record AnalystExpectations(double? MaxFailedShare, double? MaxCancelledShare, string Reason);`
  - `AnalystConfig` gains last positional parameter `AnalystExpectations? Expectations = null`.
  - `RunContextRenderer.Render(RunContext ctx, TimeRange window, AnalystExpectations? expectations = null)`.

- [ ] **Step 1: Write the failing tests**

Append to `RunContextTests.cs`:

```csharp
    [Fact]
    public void DeclaredExpectationsAreStatedForDataOutcomesOnly()
    {
        var text = RunContextRenderer.Render(Chain, Window,
            new AnalystExpectations(0.65, 0.25, "dev endless feed: 3 of every 5 files are built to fail"));

        Assert.Contains("Declared expectations (data-domain outcomes only; system problems are never covered): "
            + "failed share up to 0.65, cancelled share up to 0.25 -- dev endless feed: 3 of every 5 files are built to fail.",
            text, StringComparison.Ordinal);
    }

    [Fact]
    public void WithoutExpectationsEveryDeterministicProblemIsReported()
        => Assert.Contains("No declared expectations: report every deterministic problem.",
            RunContextRenderer.Render(Chain, Window), StringComparison.Ordinal);
```

Edit `Schemas/analyst-config.json`: set the title to `"Analyst step payload v2"` and add to `properties`:

```json
    "expectations": {
      "type": "object",
      "properties": {
        "maxFailedShare": { "type": "number", "minimum": 0, "maximum": 1 },
        "maxCancelledShare": { "type": "number", "minimum": 0, "maximum": 1 },
        "reason": { "type": "string", "minLength": 1 }
      },
      "required": ["reason"],
      "additionalProperties": false,
      "description": "What this workflow is allowed to do. Shares count data-domain outcomes only (the cause names the item); system problems are never covered. Absent: every deterministic problem is reported."
    }
```

(`expectations` stays out of `required`.)

- [ ] **Step 2: Run to verify they fail**

Run: build; `--filter-class "*AnalystConfigSchemaTests"` (fails: the schema has a property the record lacks) and `--filter-class "*RunContextTests"` (fails to compile: no `AnalystExpectations`).

- [ ] **Step 3: Implement**

`AnalystConfig.cs`:

```csharp
public sealed record AnalystConfig(
    Guid TargetWorkflowId,
    int WindowMinutes,
    string Prompt,
    string[] PanelSet,
    int MaxIterations,
    int MaxTokens,
    int WallClockSeconds,
    AnalystExpectations? Expectations = null) : ProcessorConfig;

/// <summary>
/// What a workflow is allowed to do, declared per workflow (spec D1). Shares count data-domain outcomes
/// only; a system problem is never covered.
/// </summary>
public sealed record AnalystExpectations(double? MaxFailedShare, double? MaxCancelledShare, string Reason);
```

`RunContextRenderer.Render` gains `AnalystExpectations? expectations = null` and, before `</run-context>`:

```csharp
        lines.Add(expectations is null
            ? "No declared expectations: report every deterministic problem."
            : "Declared expectations (data-domain outcomes only; system problems are never covered): "
              + string.Join(", ", new[]
                {
                    expectations.MaxFailedShare is { } f ? $"failed share up to {f.ToString("0.##", CultureInfo.InvariantCulture)}" : null,
                    expectations.MaxCancelledShare is { } c ? $"cancelled share up to {c.ToString("0.##", CultureInfo.InvariantCulture)}" : null,
                }.Where(s => s is not null))
              + $" -- {expectations.Reason}.");
```

`AnalystProcessor`: `Graph.RunContextRenderer.Render(runContext, range, config.Expectations)`.

- [ ] **Step 4: Run the tests**

Run: build; `--filter-class "*AnalystConfigSchemaTests"`, `--filter-class "*RunContextTests"`, `--filter-class "*AnalystProcessorTests"`.
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/Processor.Analyst/AnalystConfig.cs src/Processor.Analyst/Graph/RunContextRenderer.cs src/Processor.Analyst/AnalystProcessor.cs src/tests/BaseApi.Tests/Schemas/analyst-config.json src/tests/BaseApi.Tests/Analyst/RunContextTests.cs
git commit -m "feat(analyst): declared expectations in the step payload (config schema 2.0.0)"
```

---

### Task 7: Finding schema v4 and the verdict rule

**Files:**
- Modify: `src/Processor.Analyst/AnalystFinding.cs` (`FindingInsight`, `TraceEntry`)
- Modify: `src/Processor.Analyst/Tools/ToolCatalog.cs` (`submit_finding` schema)
- Modify: `src/Processor.Analyst/Loop/InvestigationLoop.cs` (insight mapping near line 327; trace serialization near line 343; the verdict rule in `Terminate`)
- Modify: `src/tests/BaseApi.Tests/Schemas/analyst-finding.json` (becomes 4.0.0)
- Modify: `src/tests/BaseApi.Tests/Analyst/AnalystScript.cs` (`Submit`/`SubmitFinding` emit the v4 fields)
- Test: `src/tests/BaseApi.Tests/Analyst/AnalystFindingSchemaTests.cs`, `InvestigationLoopTests.cs` (append)

**Interfaces:**
- Produces:
  - `internal sealed record FindingInsight(string Claim, string Why, IReadOnlyList<string> Panels, string Classification, string Domain, string Severity, string Onset, IReadOnlyList<string> EvidenceKinds);`
  - `internal sealed record TraceEntry(int Ordinal, string PanelId, bool DataReturned, DateTimeOffset? HistoryFrom = null, DateTimeOffset? HistoryTo = null);`
  - `internal static string? InvestigationLoop.VerdictProblem(string verdict, IReadOnlyList<FindingInsight> insights)` -- null when consistent.

- [ ] **Step 1: Write the failing tests**

Append to `InvestigationLoopTests.cs`:

```csharp
    private static FindingInsight Insight(string classification) => new(
        "c", "w", ["failure-causes", "step-outcomes"], classification,
        classification == "deterministic" ? "data" : "system",
        classification == "deterministic" ? "high" : "low", "since start", ["nature", "persistence"]);

    [Theory]
    [InlineData("Notable", "deterministic", null)]
    [InlineData("Drifting", "transient", null)]
    [InlineData("Notable", "transient", "Notable needs at least one deterministic insight")]
    [InlineData("Drifting", "deterministic", "Drifting carries only transient insights")]
    public void TheVerdictFollowsTheClassifications(string verdict, string classification, string? problem)
    {
        var found = InvestigationLoop.VerdictProblem(verdict, [Insight(classification)]);

        if (problem is null)
        {
            Assert.Null(found);
        }
        else
        {
            Assert.Contains(problem, found, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void SeverityMustMatchTheClassification()
        => Assert.Contains("severity",
            InvestigationLoop.VerdictProblem("Notable", [Insight("deterministic") with { Severity = "low" }]),
            StringComparison.Ordinal);
```

In `AnalystFindingSchemaTests.Sample()`, give the insight the v4 fields (`"deterministic", "data", "high", "since 2026-10-02T12:51:47Z", ["nature", "persistence"]`) and a trace entry with `HistoryFrom`/`HistoryTo` set; the existing "the sample validates against the definition" test then pins the schema.

- [ ] **Step 2: Run to verify they fail**

Run: build. Expected: compile errors on the new `FindingInsight` arguments and `VerdictProblem`.

- [ ] **Step 3: Implement**

`AnalystFinding.cs`:

```csharp
/// <summary>
/// One inference, classified (spec D3). Severity is derived, high exactly when deterministic, and is
/// carried so a reader of the topic need not know the rule.
/// </summary>
internal sealed record FindingInsight(
    string Claim, string Why, IReadOnlyList<string> Panels,
    string Classification, string Domain, string Severity, string Onset, IReadOnlyList<string> EvidenceKinds);

internal sealed record TraceEntry(
    int Ordinal, string PanelId, bool DataReturned, DateTimeOffset? HistoryFrom = null, DateTimeOffset? HistoryTo = null);
```

`InvestigationTrace.Record` builds the entry with the range: `new TraceEntry(_entries.Count + 1, panelId, dataReturned, history?.From, history?.To)` (the `Ranges` list from Task 4 stays for the loop's own use).

`ToolCatalog.cs`, `submit_finding` insight item:

```json
"insights":{"type":"array","minItems":1,"items":{
  "type":"object",
  "properties":{
    "claim":{"type":"string","minLength":1},
    "why":{"type":"string","minLength":1},
    "panels":{"type":"array","minItems":2,"uniqueItems":true,"items":{"type":"string","minLength":1}},
    "classification":{"type":"string","enum":["deterministic","transient"]},
    "domain":{"type":"string","enum":["system","data"]},
    "severity":{"type":"string","enum":["high","low"]},
    "onset":{"type":"string","minLength":1},
    "evidenceKinds":{"type":"array","minItems":2,"uniqueItems":true,"items":{"type":"string","enum":["nature","logged-as","persistence","mix","retry","scope","coincidence","conservation"]}}},
  "required":["claim","why","panels","classification","domain","severity","onset","evidenceKinds"],
  "additionalProperties":false}},
```

`InvestigationLoop.cs`, the insight mapping:

```csharp
            Insights: [.. input.GetProperty("insights").EnumerateArray().Select(i => new FindingInsight(
                i.GetProperty("claim").GetString()!,
                i.GetProperty("why").GetString()!,
                [.. i.GetProperty("panels").EnumerateArray().Select(p => p.GetString()!)],
                i.GetProperty("classification").GetString()!,
                i.GetProperty("domain").GetString()!,
                i.GetProperty("severity").GetString()!,
                i.GetProperty("onset").GetString()!,
                [.. i.GetProperty("evidenceKinds").EnumerateArray().Select(k => k.GetString()!)]))],
```

and the rule, applied in `Terminate` on the `submit_finding` path before the finding is built; a non-null problem is returned as the rejection text, which the loop already hands back to the model (up to `MaxRejections`):

```csharp
    /// <summary>The verdict rule (spec D2): Notable iff any insight is deterministic; severity follows.</summary>
    internal static string? VerdictProblem(string verdict, IReadOnlyList<FindingInsight> insights)
    {
        var mismatched = insights.FirstOrDefault(i => (i.Classification == "deterministic") != (i.Severity == "high"));
        if (mismatched is not null)
        {
            return $"insight '{mismatched.Claim}' is {mismatched.Classification} but has severity {mismatched.Severity}; "
                 + "severity is high exactly when the insight is deterministic";
        }

        var deterministic = insights.Any(i => i.Classification == "deterministic");
        return (verdict, deterministic) switch
        {
            ("Notable", false) => "Notable needs at least one deterministic insight; with only transient insights the verdict is Drifting",
            ("Drifting", true) => "Drifting carries only transient insights; a deterministic insight makes the verdict Notable",
            _ => null,
        };
    }
```

`Schemas/analyst-finding.json`: title `"Analyst finding v4"`; add the five insight properties exactly as in the tool schema above (all required), and add to the trace item `"historyFrom":{"type":["string","null"],"format":"date-time"}` and `"historyTo"` likewise (not required). Update the verdict description: "Notable carries at least one deterministic insight (operator intervention); Drifting carries only transient insights (lower severity); Quiet means no problem, or only what the declared expectations allow; Inconclusive means the evidence could not decide."

`AnalystScript.Submit`/`SubmitFinding`: add `classification = "deterministic", domain = "data", severity = "high", onset = "since start", evidenceKinds = new[] { "nature", "persistence" }` to each insight object, with `verdict = "Notable"`.

- [ ] **Step 4: Run the tests**

Run: build; full suite `BaseApi.Tests.exe`.
Expected: 0 failed. Fix every test the compiler or the run reports that builds a `FindingInsight` or submits a finding with the old shape by giving it the v4 fields.

- [ ] **Step 5: Commit**

```bash
git add -u src
git commit -m "feat(analyst): finding schema 4.0.0 -- classified insights, history ranges in the trace, the verdict rule"
```

---

### Task 8: Prompt v14 and the compiled primer

**Files:**
- Create: `tools/analyst-prompt-v14.txt` (from `tools/analyst-prompt-v13.txt`)
- Modify: `src/Processor.Analyst/ContractPrompt.cs` (primer bullets)
- Modify: `src/tests/BaseApi.Tests/Live/AnalystBitLiveTests.cs` (default prompt v14)
- Test: `src/tests/BaseApi.Tests/Analyst/PromptStructureTests.cs` (append), `RunningGraphTests.cs` (primer assertions, append)

**Interfaces:**
- Consumes: the run context and Layers text (Tasks 2-3, 6), `failure-causes` (Task 5), `read_panel.from` (Task 4), v4 insight fields (Task 7).

- [ ] **Step 1: Write the failing tests**

Append to `PromptStructureTests.cs`:

```csharp
    [Fact]
    public void PromptV14IsWellFormedAndTeachesTheOperatorRole()
    {
        var path = Path.Combine(ReplayFixtures.RepoRoot(), "tools", "analyst-prompt-v14.txt");
        var prompt = File.ReadAllText(path);

        Assert.Empty(PromptStructure.Check(prompt));
        Assert.Contains("DETERMINISTIC DATA PROBLEM", prompt, StringComparison.Ordinal);
        Assert.Contains("THE FAILURE HANDLING IS LOSING FAILURES", prompt, StringComparison.Ordinal);
        Assert.Contains("run-context", prompt, StringComparison.Ordinal);
        Assert.DoesNotContain("expected however large it is", prompt, StringComparison.Ordinal);
    }
```

Append to `RunningGraphTests.cs`:

```csharp
    [Fact]
    public void ThePrimerTeachesClassification()
    {
        var system = ContractPrompt.Compose("p");

        Assert.Contains("Every anomaly is classified deterministic or transient", system, StringComparison.Ordinal);
        Assert.Contains("author-reported", system, StringComparison.Ordinal);
        Assert.Contains("Notable when any insight is deterministic", system, StringComparison.Ordinal);
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: build; `--filter-class "*PromptStructureTests"`, `--filter-class "*RunningGraphTests"`. Expected: FAIL (file missing; primer text absent).

- [ ] **Step 3: Write the prompt and the primer**

Create `tools/analyst-prompt-v14.txt` as a copy of v13 with these changes, in order:

1. Opening paragraph, replace the first sentence with: `You are the operator for this workflow. Decide whether anything in this window -- in the system or in the data it is given -- needs an operator's intervention, and classify every problem you find as deterministic (it will continue until someone fixes the system or the data) or transient (it resolves on its own, reported at lower severity).`
2. Stage 1 task 1, append: `Then read the run-context block: the history limit (how far back any read may go), the deploy markers inside it (code and counter meanings may change at each), and the declared expectations. Read the Layers section of the running graph: the failure handlers and their fan-in, the results nothing handles, and the conservation checks you must verify.`
3. Stage 3, after hypothesis 4, add:
   `5. DETERMINISTIC DATA PROBLEM. Killed if no failure or cancellation names the item, or if every data-domain share stays within the declared expectations. Without declared expectations, any failure whose cause names the item survives this criterion.`
   `6. THE FAILURE HANDLING IS LOSING FAILURES. Killed if every conservation check in the Layers section balances. A workflow with no failure handler has no check, and this hypothesis is killed for it.`
4. Stage 4, add a bullet: `- read_panel with from reads from that instant to the window's end, clamped to the history limit. Use it only for a hypothesis a window reading made suspicious: to find a cause's onset, whether it persisted, whether its mix changed, or whether it began at a deploy marker. failure-causes gives each cause's count, first and last seen and how it was logged (author-reported, faulted, other), and the failed share per bucket.`
5. Stage 2/4 text "A count the routing explains is expected however large it is" (Task 2 in stage 1) becomes: `A count the routing explains is not a routing fault; an item-caused rate is judged against the declared expectations, and without them it is reported.`
6. Stage 5, replace the "This is task 3" paragraph's first sentence with: `This is task 3: correlate, classify and justify. Every surviving anomaly becomes an insight classified deterministic or transient by its nature first (the cause names the item or a code defect: deterministic; it names infrastructure -- timeout, connection, store or broker unavailable, a dropped response: transient), supported by at least two evidence kinds (nature, logged-as, persistence, mix, retry, scope, coincidence, conservation). State domain (data when the cause names the item, else system), severity (high exactly when deterministic) and onset (when it was first seen within the history limit, or since start). The verdict is Notable when any insight is deterministic, Drifting when all are transient.`

`ContractPrompt.cs`, add primer bullets after the run-boundaries bullet:

```text
        - Every anomaly is classified deterministic or transient. Deterministic: the cause names the item
          or its configuration (an extension, bytes, a schema, a rule that rejects it) or a code defect,
          and retrying gives the same result. Transient: the cause names infrastructure (timeout,
          connection refused or reset, store or broker unavailable, a dropped response). A failure logged
          "the author reported the step failed" (author-reported) is the step's own code rejecting the
          item; "the transform faulted" is an unexpected exception, judged by what it names.
        - Both are reported: Notable when any insight is deterministic (an operator must intervene),
          Drifting when every insight is transient (lower severity). Quiet only when nothing is wrong or
          only what the declared expectations allow. A system problem is never covered by an expectation.
        - History is optional and on demand: read back with from only to test a suspicion, never past the
          history limit in the run-context block. A cause present since the start, or since a deploy
          marker, is strong evidence it is deterministic.
```

`AnalystBitLiveTests.cs`: default prompt `tools/analyst-prompt-v14.txt`.

- [ ] **Step 4: Run the tests**

Run: build; `--filter-class "*PromptStructureTests"`, `--filter-class "*RunningGraphTests"`, `--filter-class "*BitPromptTests"`.
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add tools/analyst-prompt-v14.txt src/Processor.Analyst/ContractPrompt.cs src/tests/BaseApi.Tests/Analyst/PromptStructureTests.cs src/tests/BaseApi.Tests/Analyst/RunningGraphTests.cs src/tests/BaseApi.Tests/Live/AnalystBitLiveTests.cs
git commit -m "feat(analyst): prompt v14 and the primer teach the operator role"
```

---

### Task 9: The BIT tests the operator role

**Files:**
- Modify: `src/Processor.Analyst/Bit/BitPrompt.cs` (exam scenario and fitness requirements)
- Modify: `src/Processor.Analyst/Bit/RehearsalPanels.cs` (`failure-causes`, history-aware, three scenarios)
- Modify: `src/Processor.Analyst/Bit/RehearsalGraph.cs` (a fixture `RunContext`)
- Modify: `src/Processor.Analyst/Bit/GroundTruthRehearsal.cs` (three scenarios; briefing includes run context and expectations)
- Test: `src/tests/BaseApi.Tests/Analyst/RehearsalFixtureTests.cs`, `GroundTruthRehearsalTests.cs`, `BitPromptTests.cs`

**Interfaces:**
- Consumes: `RunContextRenderer.Render(ctx, window, expectations)`, `GraphRenderer` with Layers, v4 `submit_finding`, `VerdictProblem`.
- Produces:
  - `RehearsalPanels.Quiet()` (test-feed mix, served with expectations), `HoldingDiscardedWork()` (as today), `RejectingBadInput()` (same mix as Quiet, no expectations).
  - `internal static RunContext RehearsalGraph.RunFor(DateTimeOffset windowEnd)` (start 6 hours before the window end, no deploys).
  - `internal static readonly AnalystExpectations RehearsalGraph.TestFeed = new(0.2, 0.0, "rehearsal feed: 6 of every 40 items are built to fail validation")`.
  - `GroundTruthRehearsal.RunAsync` order: quiet (must be Quiet) -> loss (must be Notable with a deterministic system insight) -> bad input (must be Notable with a deterministic data insight).

- [ ] **Step 1: Write the failing tests**

Append to `RehearsalFixtureTests.cs`:

```csharp
    [Fact]
    public void FailureCausesNamesTheItemAndPersistsSinceTheStart()
    {
        var panels = RehearsalPanels.RejectingBadInput();
        var value = Read(panels, "failure-causes");

        var cause = Assert.Single(value.GetProperty("causes").EnumerateArray());
        Assert.Equal("author-reported", cause.GetProperty("logged").GetString());
        Assert.Contains("extension", cause.GetProperty("cause").GetString(), StringComparison.Ordinal);
        Assert.Equal(6, cause.GetProperty("count").GetInt64());
    }

    [Fact]
    public async Task AHistoryReadShowsTheSameShareInEveryBucket()
    {
        var panels = RehearsalPanels.RejectingBadInput();
        var history = new TimeRange(RehearsalGraph.RunFor(Window.To).HistoryLimit!.Value, Window.To);
        var reading = await panels.ReadAsync("failure-causes", RehearsalGraph.WorkflowId, history, true, CancellationToken.None);

        var shares = JsonDocument.Parse(reading.ValueJson).RootElement.GetProperty("buckets").EnumerateArray()
            .Where(b => b.GetProperty("imported").GetInt64() > 0)
            .Select(b => b.GetProperty("failedShare").GetDouble()).Distinct().ToList();
        Assert.Equal([0.15], shares);
    }

    [Fact]
    public void OnlyTheQuietScenarioCarriesExpectations()
    {
        Assert.NotNull(RehearsalPanels.Quiet().Expectations);
        Assert.Null(RehearsalPanels.RejectingBadInput().Expectations);
        Assert.Null(RehearsalPanels.HoldingDiscardedWork().Expectations);
    }
```

Add `"failure-causes"` to the expected panel list in `EveryReadingHasTheShapeTheLiveSourceProduces`, and make that test skip the live-shape comparison for `failure-causes` when the captured fixture has no `failure-causes.json` (it predates the panel); compare against `Fixtures/esql-causes.json`'s parsed reading instead by building it through `ElasticPanelSource` in a helper.

In `GroundTruthRehearsalTests.cs`, script three investigations in `APromptThatStaysQuietAndThenReportsTheFaultPasses` (renamed `...ReportsBothFaultsPasses`): quiet -> `ConcludesNothing()`, loss -> `ConcludesFinding()`, bad input -> `ConcludesFinding()`; add `APromptThatStaysQuietOnUndeclaredBadInputFails` (third investigation `ConcludesNothing()`, expect one `verify` problem containing `"bad input"`).

Append to `BitPromptTests.cs`:

```csharp
    [Fact]
    public void TheExamRequiresClassificationAndReportingBadInput()
    {
        Assert.Contains("deterministic or transient", BitPrompt.System, StringComparison.Ordinal);
        Assert.Contains("no declared expectation", BitPrompt.System, StringComparison.Ordinal);
        Assert.Contains("run-context block", BitPrompt.System, StringComparison.Ordinal);
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: build. Expected: compile errors (`RejectingBadInput`, `RehearsalGraph.RunFor`, `Expectations`).

- [ ] **Step 3: Implement**

`RehearsalGraph.cs`:

```csharp
    /// <summary>The fixture run began six hours before any rehearsal window; no deploys since.</summary>
    internal static RunContext RunFor(DateTimeOffset windowEnd)
        => new(windowEnd.AddHours(-6), windowEnd.AddHours(-6), [], null);

    internal static readonly AnalystExpectations TestFeed =
        new(0.2, 0.0, "rehearsal feed: 6 of every 40 items are built to fail validation");
```

`RehearsalPanels.cs`:
- add `internal AnalystExpectations? Expectations { get; }` set by the factories: `Quiet()` -> `RehearsalGraph.TestFeed`; `HoldingDiscardedWork()` and `RejectingBadInput()` -> `null`. `RejectingBadInput()` uses the same ledger as `Quiet()` (`lost: 0`).
- add `"failure-causes"` to `PanelIds` and a builder: one cause `{step: "validate-file_1.0.0", logged: "author-reported", cause: "the author reported the step failed: fetching item-<n>.dat failed: the extension '.dat' is not one of the allowed extensions [.zip]", count: 6, firstSeen, lastSeen}` over the window; buckets from `ElasticPanelSource.BucketFor(range)`, each with the window's per-bucket shape scaled to that width (imported `40 * width / 15 min`, failed `6 * ...`, cancelled `5 * ...`, `failedShare` 0.15). On a history range the cause's `firstSeen` is the range start and its count scales with the range, so persistence since the start is visible.
- the loss scenario serves the same `failure-causes` reading as the others: a parked refusal is not a step outcome, so it never appears there. The loss stays visible where it is today -- refused-messages, dead-letter growth, the step-outcomes shortfall and terminal at persist-file.

`GroundTruthRehearsal.cs`:
- the briefing becomes `RehearsalGraph.Briefing + "\n\n" + RunContextRenderer.Render(RehearsalGraph.RunFor(to), new TimeRange(to - Window, to), panels.Expectations)`, passed to `loop.RunAsync(..., briefing, historyLimit: RehearsalGraph.RunFor(to).HistoryLimit)`.
- after the loss scenario passes, run `RejectingBadInput()`; a `NoFinding` there returns:

```csharp
            return [new StageProblem("verify", "contradicting",
                "against a rehearsal window in which 15% of items failed validation for a cause in the item "
                + "itself, steadily since the workflow's start, with no declared expectation, the prompt "
                + $"reported nothing: \"{missed.Reason}\" -- undeclared bad input is a deterministic data "
                + "problem the operator must hear about")];
```

- a `Finding` in the loss or bad-input scenario must carry at least one insight with `Classification == "deterministic"` and the matching domain (`system` for loss, `data` for bad input); otherwise return a `verify` problem naming the expected classification.
- the quiet scenario keeps its message, adding: "and the 15% rejection rate is within the declared expectation".

`BitPrompt.cs`, the scenario paragraph gains, after the loss sentence: `The run-context block states the workflow started six hours ago with no declared expectation for this source, and failure-causes shows the refused file type in every bucket since the start.` The fit answer becomes: `A fit investigation reports two deterministic problems -- the loss of 17 items (system) and a provider sending a refused file type since the start (data, because no declared expectation covers it) -- classifies each with at least two kinds of evidence, and treats the cancellations and the terminal shape as the routing at work.` The requirements list gains: `require every problem found to be classified deterministic or transient by its nature and supported by at least two kinds of evidence; require undeclared bad input to be reported; require history reads to stay within the history limit of the run-context block.`

- [ ] **Step 4: Run the tests**

Run: build; full suite.
Expected: 0 failed, skips only in `Live/`.

- [ ] **Step 5: Commit**

```bash
git add -u src
git commit -m "feat(analyst-bit): exam and three-scenario rehearsal for the operator role"
```

---

### Task 10: Deploy and document

**Files:**
- Modify: `docs/rebuild-analyst-monitor-workflow.md` (schema rows 2.0.0 and 4.0.0 definitions; step payload with v14, `failure-causes` in `panelSet`, `expectations`; SourceHash)
- Modify: `docs/offline-steprole-drop.md` (the new rows, the repoint order, the new hash)

**Interfaces:** none (operations).

- [ ] **Step 1: Run the live BIT against v14 before touching dev** (costs about $1.50; ask the user first)

Run: `cd src/tests/BaseApi.Tests && SKP_ANALYST_REPLAY=1 ./bin/Debug/net8.0/BaseApi.Tests.exe --filter-method "*AnalystBitLiveTests.TheDeployedPromptPassesTheFullBit"`
Expected: PASS. A Kimi reply with no tool call fails the run without saying anything about the prompt; re-run.

- [ ] **Step 2: Create the schema rows**

POST `src/tests/BaseApi.Tests/Schemas/analyst-config.json` as `analyst-config` 2.0.0 and `analyst-finding.json` as `analyst-finding` 4.0.0 to `http://localhost:18080/api/v1/schemas` (body shape: the runbook's step 2). Record both ids.

- [ ] **Step 3: Build, repoint, roll out**

```powershell
dotnet build src/Processor.Analyst/Processor.Analyst.csproj -v q
$asm  = [Reflection.Assembly]::LoadFrom((Resolve-Path "src/Processor.Analyst/bin/Debug/net8.0/Processor.Analyst.dll"))
$hash = ($asm.GetCustomAttributes([Reflection.AssemblyMetadataAttribute], $false) | Where-Object Key -eq 'SourceHash').Value
```

PUT `/api/v1/processors/f361e170-c899-43d1-9a0e-4d30ff2cad87` with every field resent, changing `sourceHash`, `outputSchemaId` (4.0.0 id) and `configSchemaId` (2.0.0 id). Then:

```bash
docker build -f src/Processor.Analyst/Dockerfile -t processor-analyst:local .
kind load docker-image processor-analyst:local --name desktop
kubectl -n skp rollout restart deploy/processor-analyst && kubectl -n skp rollout status deploy/processor-analyst --timeout=300s
```

Expected: both pods log `resolving identity for source hash <hash>` and `all schema definitions resolved ... output=<4.0.0 id> config=<2.0.0 id>`.

- [ ] **Step 4: Update the assignment**

GET `/api/v1/assignments/2f1cc7d1-5ffb-495e-be65-1adfd8db458d`, change only the payload: `prompt` = `tools/analyst-prompt-v14.txt` (trailing newline dropped), append `"failure-causes"` to `panelSet`, add `"expectations": {"maxFailedShare": 0.65, "maxCancelledShare": 0.25, "reason": "dev endless feed: 3 of every 5 files are built to fail, 1 to be cancelled"}`. PUT with every field resent; read back and compare every other field.

- [ ] **Step 5: Fire once and verify** (ask the user first; the first fire pays the full BIT, about 12-14 minutes)

Run the endless feed (`python -u tools/simulate-endless-feed.py --start-serial <next>` from PowerShell), wait 5 minutes, fire `analyst-monitor` once with the one-shot-cron procedure and stop it. Expected on `skp-analyst-findings`: verdict Quiet with the reason naming the declared expectation; then remove `expectations` from the payload, fire again, expected: Notable with a deterministic data insight whose onset is at or after the workflow's start.

- [ ] **Step 6: Capture replay windows** (no model calls; free)

Capture three windows with `SKP_ANALYST_CAPTURE=1 SKP_CAPTURE_NAME=<name> SKP_CAPTURE_FROM=<iso> SKP_CAPTURE_TO=<iso> ./bin/Debug/net8.0/BaseApi.Tests.exe --filter-method "*CaptureAWindow"` from `src/tests/BaseApi.Tests`, and write each answer key in `window.json` by hand, separating what was predicted before reading from what was corroborated after:
- `operator-declared`: endless feed with the declared expectation -- correct verdict Quiet;
- `operator-undeclared`: the same feed without it -- Notable, deterministic, data, onset at or after the start;
- `operator-transient`: a Redis `CLIENT PAUSE 60000` during the window (never scale Redis) -- Drifting, transient, system.
Extend `CaptureAWindow` to save `failure-causes.json` and the run context (`run-context.json`) next to the panels. Score v14 with `SKP_ANALYST_REPLAY=1` only with the user's go-ahead (each run is paid).

- [ ] **Step 7: Document and commit**

Update the runbook's step 2 (both schema definitions), step 3 (`sourceHash`), step 6.1 (payload regenerated from v14 by the same JSON round trip used for v13), and the provenance list; update `docs/offline-steprole-drop.md` with the two new rows and the order: schema rows, processor PUT, image, rollout, assignment.

```bash
git add docs/rebuild-analyst-monitor-workflow.md docs/offline-steprole-drop.md
git commit -m "docs: analyst operator role -- schema rows 2.0.0/4.0.0, payload v14, SourceHash"
```
