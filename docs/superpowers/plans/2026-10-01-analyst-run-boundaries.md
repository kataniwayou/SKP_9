# Analyst Run Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Analyst's `run-boundaries` panel counts what the operator's pie counts (fires that entered in the window, and every branch end of those fires), its description stops teaching a fixed ratio, and the `analyst-monitor` prompt carries the target workflow's graph facts.

**Architecture:** The panel stays an Elasticsearch `_search` body read by `ElasticPanelSource`. The join is a `terms` aggregation on `attributes.CorrelationId` with entry and terminal filter sub-aggregations, a `bucket_selector` keeping fires with an entry, and `stats_bucket` / `sum_bucket` siblings for the two counts. A new `{{RUNS}}` placeholder sizes the terms aggregation from the read's time range; `sum_other_doc_count > 0` marks the reading as not covering the window. The prompt is a payload value, changed through BaseApi; nothing about the BIT changes.

**Tech Stack:** .NET 8, xUnit v3 (Microsoft Testing Platform exe runner), Elasticsearch 9.3.4 aggregations, BaseApi REST, kind.

**Spec:** `docs/superpowers/specs/2026-10-01-analyst-run-boundaries-and-graph-design.md` (approved 2026-10-01). Background: `docs/testing/kibana-panels-through-the-graph.md`.

## Global Constraints

- Panel id stays `run-boundaries`, layer `business`, kind `PanelKind.Elastic`. No new panel, no new panel kind.
- The reading's value fields keep their names: `totalWorkflowRecords`, `entry`, `terminal`, `importerPolls`, `drainedPolls`. `RehearsalPanels` and `AnalystGroundTruthLiveTests` hand-write readings in this shape and must stay valid unchanged.
- `entry` = distinct CorrelationIds with an entry record in the window. `terminal` = terminal **records** (not distinct) whose CorrelationId is one of those. Terminals of fires that entered before the window are excluded.
- Run-position key and values come from `RunPositions` via `WithRunPositions`. No literal `"entry"`, `"terminal"` or `"RunPosition"` in the query.
- The terms `size` comes from `{{RUNS}}` = whole seconds in the read range, minimum 1, maximum 60000 (under Elasticsearch's 65,536 `search.max_buckets`).
- A reading whose terms aggregation reports `sum_other_doc_count > 0` has `WindowFullyCovered = false`.
- The BIT exam, judge, scenarios and `RehearsalPanels` are not changed.
- Test runner: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q`, then `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe` (`--filter-class "<Namespace.Class>"` for one class). `dotnet test` hides failure names; `--filter "Category!=…"` is silently ignored.
- Suite gate: 0 failed, exit 0, every skip under `Live/`.
- `Processor.Analyst` is a project reference of the tests (not a package), so no repack is needed.
- BaseApi is the only way to change the workflow and its payload. A payload edit reaches a running workflow only after stop + start.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **A window with more runs than `{{RUNS}}` buckets.** Expected: the reading still returns, with `WindowFullyCovered = false`, rather than silently reporting an undercount as fully covered. Pinned in Task 2 (`Elastic_RunBoundaries_MoreRunsThanBucketsIsNotFullyCovered`).
2. **A window where the workflow logs records but has no boundaries at all.** Expected: a trusted zero (`entry 0`, `terminal 0`, `SeriesPresent = true`), as today, because `stats_bucket` over no buckets returns count 0. Pinned in Task 2 (`Elastic_RunBoundaries_NoBoundariesWhileTheWorkflowIsReportingIsATrustedZero`, fixture rewritten).
3. **A fire whose entry is before the window and whose terminals are inside it.** Expected: those terminals are not counted. Pinned by the fixture in Task 2, which carries such a bucket in the raw response but excludes it in the asserted totals because `bucket_selector` dropped it (the parser must read the sibling totals, not sum the buckets itself).
4. **A very long or very short read range.** Expected: `{{RUNS}}` is clamped to [1, 60000], so neither a zero-length range nor a 24h range produces an invalid request. Pinned in Task 2 (`RunsPlaceholderIsClampedToTheBucketLimit`).
5. **The prompt edit breaking the five-stage structure.** Expected: the new text lands inside STAGE 4's rule list, and the deterministic structure check still passes on it. Pinned in Task 4 (`PromptStructure` check run against the new file before it is published).

---

## File map

| File | Change |
|---|---|
| `docs/superpowers/specs/2026-10-01-analyst-run-boundaries-and-graph-design.md` | §4/§5/§8: cross-checks limited to what the Analyst's panels show; prompt file versioning |
| `src/Processor.Analyst/Panels/PanelRegistry.cs` | `run-boundaries` query and description |
| `src/Processor.Analyst/Panels/ElasticPanelSource.cs` | `{{RUNS}}` substitution; `BuildRunBoundaries` reads the new aggregation |
| `src/tests/BaseApi.Tests/Analyst/Fixtures/elastic-run-boundaries-present.json` | rewritten to the new response shape |
| `src/tests/BaseApi.Tests/Analyst/Fixtures/elastic-run-boundaries-zero.json` | rewritten to the new response shape |
| `src/tests/BaseApi.Tests/Analyst/Fixtures/elastic-run-boundaries-capped.json` | new |
| `src/tests/BaseApi.Tests/Analyst/PanelTrustTests.cs` | run-boundaries parse and plumbing tests |
| `src/tests/BaseApi.Tests/Analyst/PanelRegistryTests.cs` | query-shape and description tests |
| `src/tests/BaseApi.Tests/Analyst/PromptStructureTests.cs` | the v8 prompt passes the structure check |
| `tools/analyst-prompt-v7.txt` | corrected to the live prompt as it was before this change |
| `tools/analyst-prompt-v8.txt` | new: the prompt this change publishes |

---

### Task 1: Amend the spec to what the Analyst can actually read

The approved spec's §4 lists cross-checks ("post-fork steps at 2× alphabeta", "Unlisted equal to the sample normalizer's Cancelled") that need per-step and whitelist readings. The Analyst's `step-outcomes` panel returns totals by result only, and it has no whitelist panel. The one cross-check its panels support, verified on all three windows of the analysis, is **terminal − Failed − Cancelled = 2 × good records** (mixed 225 − 111 − 40 = 74; approved 1069 − 0 − 69 = 1000; idle 60 − 0 − 60 = 0).

**Files:**
- Modify: `docs/superpowers/specs/2026-10-01-analyst-run-boundaries-and-graph-design.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the spec text Task 4's prompt follows.

- [ ] **Step 1: Replace the "expectations" bullet of §4**

Replace the bullet that begins `- **The expectations they give, as cross-checks between panels:**` with:

```markdown
- **The expectation they give, limited to what the Analyst's panels show.** Its `step-outcomes`
  panel returns totals by result, not per step, and it has no whitelist panel, so the per-step checks
  in the analysis (post-fork at 2× alphabeta, Unlisted equal to the sample normalizer's Cancelled)
  are operator-only. The one check its panels support: **run-boundaries terminal − step-outcomes
  Failed − step-outcomes Cancelled = 2 × good records**, so it is even and not negative, give or take
  runs that straddle the window edges. Verified on all three analysis windows (225 − 111 − 40 = 74;
  1069 − 0 − 69 = 1000; 60 − 0 − 60 = 0). Plus: the Completed share of `step-outcomes` is not a
  success rate (11 Completed per good record, 2 more per failure).
```

- [ ] **Step 2: Replace the prompt-file paragraph of §5**

Replace the paragraph that begins `` `tools/analyst-prompt-v7.txt` is replaced with the live prompt after the update. `` with:

```markdown
`tools/analyst-prompt-v7.txt` is corrected to the live prompt as it stands before this change (it
differs today on the run-boundaries line), and the new prompt is `tools/analyst-prompt-v8.txt`, so
the files keep one version each.
```

- [ ] **Step 3: Fix rollout step 6 of §8**

Replace `6. Sync `tools/analyst-prompt-v7.txt`; add the changed files to the offline ship delta.` with:

```markdown
6. Commit `tools/analyst-prompt-v7.txt` (corrected) and `tools/analyst-prompt-v8.txt` (published);
   add the changed files to the offline ship delta.
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-01-analyst-run-boundaries-and-graph-design.md
git commit -m "docs(spec): limit the Analyst's graph checks to what its panels show

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The `run-boundaries` query counts entered fires and their terminals

**Files:**
- Modify: `src/Processor.Analyst/Panels/PanelRegistry.cs` (the `run-boundaries` `Query`)
- Modify: `src/Processor.Analyst/Panels/ElasticPanelSource.cs` (`ReadAsync` substitution, `BuildRunBoundaries`)
- Modify: `src/tests/BaseApi.Tests/Analyst/Fixtures/elastic-run-boundaries-present.json`
- Modify: `src/tests/BaseApi.Tests/Analyst/Fixtures/elastic-run-boundaries-zero.json`
- Create: `src/tests/BaseApi.Tests/Analyst/Fixtures/elastic-run-boundaries-capped.json`
- Test: `src/tests/BaseApi.Tests/Analyst/PanelTrustTests.cs`, `src/tests/BaseApi.Tests/Analyst/PanelRegistryTests.cs`

**Interfaces:**
- Consumes: `RunPositions.Key`, `RunPositions.Entry`, `RunPositions.Terminal` (Messaging.Contracts); `PanelRegistry.WithRunPositions`.
- Produces: `internal static int ElasticPanelSource.RunsFor(TimeRange range)`, which returns the `{{RUNS}}` value. Response shape: `aggregations.boundaries.by_run` (terms, with `sum_other_doc_count`), `aggregations.boundaries.entered_runs.count`, `aggregations.boundaries.entered_terminals.value`, plus the unchanged `polls` and `earliest`.

- [ ] **Step 1: Rewrite the three fixtures**

`src/tests/BaseApi.Tests/Analyst/Fixtures/elastic-run-boundaries-present.json`: 20 fires entered, 40 terminals among them. The raw buckets include one fire (`c-old`) that entered BEFORE the window: Elasticsearch has already dropped it with `bucket_selector`, so it is absent from `buckets`, and the sibling totals do not include it. The parser must read the totals.

```json
{
  "took": 6,
  "timed_out": false,
  "_shards": { "total": 1, "successful": 1, "skipped": 0, "failed": 0 },
  "hits": { "total": { "value": 940, "relation": "eq" }, "max_score": null, "hits": [] },
  "aggregations": {
    "boundaries": {
      "doc_count": 62,
      "by_run": {
        "doc_count_error_upper_bound": 0,
        "sum_other_doc_count": 0,
        "buckets": [
          { "key": "c-01", "doc_count": 3, "entry": { "doc_count": 1 }, "terminal": { "doc_count": 2 } }
        ]
      },
      "entered_runs": { "count": 20, "min": 1.0, "max": 1.0, "avg": 1.0, "sum": 20.0 },
      "entered_terminals": { "value": 40.0 }
    },
    "polls": { "doc_count": 20, "drained": { "doc_count": 8 } },
    "earliest": { "value": 1790208000000.0, "value_as_string": "2026-09-24T00:00:00.000Z" }
  }
}
```

`src/tests/BaseApi.Tests/Analyst/Fixtures/elastic-run-boundaries-zero.json` (records exist, no boundaries; `stats_bucket` over no buckets returns count 0 and null statistics, `sum_bucket` returns 0):

```json
{
  "took": 6,
  "timed_out": false,
  "_shards": { "total": 1, "successful": 1, "skipped": 0, "failed": 0 },
  "hits": { "total": { "value": 940, "relation": "eq" }, "max_score": null, "hits": [] },
  "aggregations": {
    "boundaries": {
      "doc_count": 0,
      "by_run": { "doc_count_error_upper_bound": 0, "sum_other_doc_count": 0, "buckets": [] },
      "entered_runs": { "count": 0, "min": null, "max": null, "avg": null, "sum": 0.0 },
      "entered_terminals": { "value": 0.0 }
    },
    "polls": { "doc_count": 0, "drained": { "doc_count": 0 } },
    "earliest": { "value": 1790208000000.0, "value_as_string": "2026-09-24T00:00:00.000Z" }
  }
}
```

Create `src/tests/BaseApi.Tests/Analyst/Fixtures/elastic-run-boundaries-capped.json` (more runs touched the window than the terms size held):

```json
{
  "took": 6,
  "timed_out": false,
  "_shards": { "total": 1, "successful": 1, "skipped": 0, "failed": 0 },
  "hits": { "total": { "value": 940, "relation": "eq" }, "max_score": null, "hits": [] },
  "aggregations": {
    "boundaries": {
      "doc_count": 62,
      "by_run": { "doc_count_error_upper_bound": 0, "sum_other_doc_count": 14, "buckets": [] },
      "entered_runs": { "count": 20, "min": 1.0, "max": 1.0, "avg": 1.0, "sum": 20.0 },
      "entered_terminals": { "value": 40.0 }
    },
    "polls": { "doc_count": 20, "drained": { "doc_count": 8 } },
    "earliest": { "value": 1790208000000.0, "value_as_string": "2026-09-24T00:00:00.000Z" }
  }
}
```

- [ ] **Step 2: Write the failing parse and plumbing tests**

In `src/tests/BaseApi.Tests/Analyst/PanelTrustTests.cs`, keep `Elastic_RunBoundaries_ReportsBothEndsAndTheDrainedPollsThatExplainAGap` and `Elastic_RunBoundaries_NoBoundariesWhileTheWorkflowIsReportingIsATrustedZero` as they are (their assertions still hold on the rewritten fixtures). Add, after them:

```csharp
    [Fact]
    public void Elastic_RunBoundaries_ReadsTheSiblingTotalsNotTheReturnedBuckets()
    {
        // The present fixture returns ONE bucket, yet 20 fires and 40 terminals. A parser that summed
        // the buckets itself would report 1 and 2 -- and, worse, would count a fire bucket_selector
        // kept by mistake. The totals are computed by Elasticsearch after the selector ran.
        var reading = ElasticPanelSource.Parse(
            Def("run-boundaries"), Window, Fixture("elastic-run-boundaries-present.json"));

        using var value = JsonDocument.Parse(reading.ValueJson);
        Assert.Equal(20, value.RootElement.GetProperty("entry").GetInt64());
        Assert.Equal(40, value.RootElement.GetProperty("terminal").GetInt64());
        Assert.True(reading.Trust.WindowFullyCovered);
    }

    [Fact]
    public void Elastic_RunBoundaries_MoreRunsThanBucketsIsNotFullyCovered()
    {
        // sum_other_doc_count > 0: some runs never got a bucket, so entry and terminal are lower
        // bounds. The reading is still returned -- a lower bound is evidence -- but it must not be
        // trusted as covering the window.
        var reading = ElasticPanelSource.Parse(
            Def("run-boundaries"), Window, Fixture("elastic-run-boundaries-capped.json"));

        Assert.True(reading.Trust.SeriesPresent);
        Assert.False(reading.Trust.WindowFullyCovered);
    }

    [Theory]
    [InlineData(0, 1)]
    [InlineData(900, 900)]
    [InlineData(21600, 21600)]
    [InlineData(86400, 60000)]
    public void RunsPlaceholderIsClampedToTheBucketLimit(int seconds, int expected)
    {
        var from = DateTimeOffset.FromUnixTimeSeconds(1790208000);
        Assert.Equal(expected, ElasticPanelSource.RunsFor(new TimeRange(from, from.AddSeconds(seconds))));
    }

    [Fact]
    public async Task ElasticPanelSource_RunBoundariesSubstitutesTheRunsBucketSize()
    {
        var handler = new RecordingHandler(HttpStatusCode.OK, Fixture("elastic-run-boundaries-present.json"));
        var source = new ElasticPanelSource(
            new HttpClient(handler, disposeHandler: false),
            Options.Create(new PanelSourceOptions { ElasticBaseUrl = "http://elasticsearch:9200" }));

        await source.ReadAsync(Def("run-boundaries"), TargetWorkflowId, Window, CancellationToken.None);

        // Window is six hours: 21,600 seconds, one bucket per possible one-second fire.
        Assert.Contains("\"size\": 21600", handler.LastBody, StringComparison.Ordinal);
        Assert.DoesNotContain("{{RUNS}}", handler.LastBody, StringComparison.Ordinal);
    }
```

In `src/tests/BaseApi.Tests/Analyst/PanelRegistryTests.cs`, delete `RunBoundariesCountsRecordsRatherThanDedupingByRun` and add in its place:

```csharp
    [Fact]
    public void RunBoundariesCountsEnteredFiresAndEveryTerminalOfThem()
    {
        // The operator pie's rule since 2026-10-01: fires are distinct CorrelationIds with an entry
        // in the window, and terminals are RECORDS (not deduplicated) whose CorrelationId is one of
        // those fires. Counting terminal records keeps partial loss visible -- a fire that lost one
        // of its two branches shows one terminal fewer -- which was the reason the old panel refused
        // to deduplicate at all.
        var query = PanelRegistry.All.Single(p => p.PanelId == "run-boundaries").Query;

        Assert.Contains("\"field\": \"attributes.CorrelationId\"", query, StringComparison.Ordinal);
        Assert.Contains("\"size\": {{RUNS}}", query, StringComparison.Ordinal);
        Assert.Contains("bucket_selector", query, StringComparison.Ordinal);
        Assert.Contains("\"entered_runs\": { \"stats_bucket\": { \"buckets_path\": \"by_run>entry._count\" } }",
            query, StringComparison.Ordinal);
        Assert.Contains("\"entered_terminals\": { \"sum_bucket\": { \"buckets_path\": \"by_run>terminal._count\" } }",
            query, StringComparison.Ordinal);
        Assert.DoesNotContain("cardinality", query, StringComparison.OrdinalIgnoreCase);
    }
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Analyst.PanelTrustTests"
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Analyst.PanelRegistryTests"
```

Expected: the build fails on `ElasticPanelSource.RunsFor` not existing. Comment out the two tests that call it, rebuild, and confirm the parse tests fail with `KeyNotFoundException` (the parser still reads `by_position`) and `RunBoundariesCountsEnteredFiresAndEveryTerminalOfThem` fails on the missing `attributes.CorrelationId`. Uncomment them again.

- [ ] **Step 4: Replace the `run-boundaries` query in `PanelRegistry.cs`**

Replace the whole `Query: WithRunPositions(""" … """)` argument of the `run-boundaries` `PanelDefinition` with:

```csharp
            Query: WithRunPositions(
                """
                {
                  "size": 0,
                  "track_total_hits": true,
                  "query": {
                    "bool": {
                      "filter": [
                        { "range": { "@timestamp": { "gte": "{{FROM}}", "lte": "{{TO}}" } } },
                        { "term": { "attributes.WorkflowId": "{{WORKFLOW}}" } }
                      ]
                    }
                  },
                  "aggs": {
                    "boundaries": {
                      "filter": {
                        "terms": { "attributes.$KEY$": [ "$ENTRY$", "$TERMINAL$" ] }
                      },
                      "aggs": {
                        "by_run": {
                          "terms": { "field": "attributes.CorrelationId", "size": {{RUNS}} },
                          "aggs": {
                            "entry": { "filter": { "term": { "attributes.$KEY$": "$ENTRY$" } } },
                            "terminal": { "filter": { "term": { "attributes.$KEY$": "$TERMINAL$" } } },
                            "entered": {
                              "bucket_selector": {
                                "buckets_path": { "e": "entry._count" },
                                "script": "params.e > 0"
                              }
                            }
                          }
                        },
                        "entered_runs": { "stats_bucket": { "buckets_path": "by_run>entry._count" } },
                        "entered_terminals": { "sum_bucket": { "buckets_path": "by_run>terminal._count" } }
                      }
                    },
                    "polls": {
                      "filter": {
                        "term": {
                          "attributes.{OriginalFormat}":
                            "consumed {Consumed}/{Requested} records; stopped because {Reason}"
                        }
                      },
                      "aggs": {
                        "drained": { "filter": { "term": { "attributes.Consumed": 0 } } }
                      }
                    },
                    "earliest": { "min": { "field": "@timestamp" } }
                  }
                }
                """)),
```

- [ ] **Step 5: Substitute `{{RUNS}}` and add `RunsFor` in `ElasticPanelSource.cs`**

In `ReadAsync`, extend the substitution chain:

```csharp
        var body = definition.Query
            .Replace("{{FROM}}", range.From.UtcDateTime.ToString("o"), StringComparison.Ordinal)
            .Replace("{{TO}}", range.To.UtcDateTime.ToString("o"), StringComparison.Ordinal)
            .Replace("{{WORKFLOW}}", targetWorkflowId.ToString("D"), StringComparison.Ordinal)
            .Replace("{{RUNS}}", RunsFor(range).ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal);
```

Add `using System.Globalization;` at the top, and this method next to `IsWindowFullyCovered`:

```csharp
    /// <summary>
    /// The terms size for a per-run aggregation: one bucket per second of the range, because the cron
    /// floor is one fire per second. Clamped to [1, 60000] -- below Elasticsearch's 65,536
    /// search.max_buckets, so a long range still reads (as a lower bound, flagged by
    /// sum_other_doc_count) rather than failing the request.
    /// </summary>
    internal static int RunsFor(TimeRange range)
    {
        var seconds = Math.Ceiling((range.To - range.From).TotalSeconds);
        return (int)Math.Clamp(seconds, 1, 60000);
    }
```

- [ ] **Step 6: Rewrite `BuildRunBoundaries`**

Replace its body with:

```csharp
    private static PanelReading BuildRunBoundaries(
        PanelDefinition definition, long total, JsonElement aggregations, bool windowFullyCovered)
    {
        var boundaries = aggregations.GetProperty("boundaries");
        var byRun = boundaries.GetProperty("by_run");
        var polls = aggregations.GetProperty("polls");

        // Read Elasticsearch's sibling totals, computed after bucket_selector dropped the fires that
        // entered before the window -- never a sum over the returned buckets.
        var entry = boundaries.GetProperty("entered_runs").GetProperty("count").GetInt64();
        var terminal = (long)boundaries.GetProperty("entered_terminals").GetProperty("value").GetDouble();

        // Runs that did not fit in the terms size: entry and terminal are then lower bounds.
        var capped = byRun.GetProperty("sum_other_doc_count").GetInt64() > 0;

        var valueJson = JsonSerializer.Serialize(new
        {
            totalWorkflowRecords = total,
            entry,
            terminal,
            importerPolls = polls.GetProperty("doc_count").GetInt64(),
            drainedPolls = polls.GetProperty("drained").GetProperty("doc_count").GetInt64(),
        });

        return new PanelReading(
            definition.PanelId, definition.Layer, valueJson, SampleCount: checked((int)total),
            new PanelTrust(SeriesPresent: true, windowFullyCovered && !capped, NoDataDistinguishable: true));
    }
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Analyst.PanelTrustTests"
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Analyst.PanelRegistryTests"
```

Expected: both classes 0 failed.

- [ ] **Step 8: Prove the shipped query against live Elasticsearch**

With the port-forward on 19200, substitute the placeholders by hand and run the mixed-feed window, where the operator pie reads 40 / 225:

```bash
python - <<'EOF'
import json, re, urllib.request
src = open("src/Processor.Analyst/Panels/PanelRegistry.cs", encoding="utf-8").read()
start = src.index('PanelId: "run-boundaries"')
q = src[src.index('"""', start) + 3: src.index('"""', src.index('"""', start) + 3)]
q = (q.replace("$KEY$", "RunPosition").replace("$ENTRY$", "entry").replace("$TERMINAL$", "terminal")
      .replace("{{FROM}}", "2026-09-30T20:18:00Z").replace("{{TO}}", "2026-09-30T20:38:00Z")
      .replace("{{WORKFLOW}}", "1a56b3ca-e276-4815-87fa-5c2f48ab6dad").replace("{{RUNS}}", "1200"))
req = urllib.request.Request("http://localhost:19200/logs-generic.otel-default/_search",
                             data=q.encode(), method="POST", headers={"Content-Type": "application/json"})
b = json.load(urllib.request.urlopen(req))["aggregations"]["boundaries"]
print(b["entered_runs"]["count"], b["entered_terminals"]["value"], b["by_run"]["sum_other_doc_count"])
EOF
```

Expected: `40 225.0 0`. (`RunPositions.Key` is `RunPosition`, `Entry` is `entry`, `Terminal` is `terminal`, in `src/Messaging.Contracts/RunPositions.cs`.)

- [ ] **Step 9: Commit**

```bash
git add src/Processor.Analyst/Panels/PanelRegistry.cs src/Processor.Analyst/Panels/ElasticPanelSource.cs \
        src/tests/BaseApi.Tests/Analyst/PanelTrustTests.cs src/tests/BaseApi.Tests/Analyst/PanelRegistryTests.cs \
        src/tests/BaseApi.Tests/Analyst/Fixtures/elastic-run-boundaries-*.json
git commit -m "feat(analyst): run-boundaries counts entered fires and every terminal of them

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The `run-boundaries` description stops teaching a fixed ratio

**Files:**
- Modify: `src/Processor.Analyst/Panels/PanelRegistry.cs` (the `run-boundaries` `Description` and the comment above the definition)
- Test: `src/tests/BaseApi.Tests/Analyst/PanelRegistryTests.cs`

**Interfaces:**
- Consumes: Task 2's query (the description describes it).
- Produces: nothing other tasks call.

- [ ] **Step 1: Replace the description test**

In `PanelRegistryTests.cs`, delete `RunBoundariesTellsTheModelTheRatioIsAWorkflowConstant` and add:

```csharp
    [Fact]
    public void RunBoundariesTellsTheModelThereIsNoFixedRatio()
    {
        // Measured 2026-10-01 on filefetcher-archiveexpander-chain: 60:60 idle, 40:225 with the mixed
        // feed, 159:1069 with the approved feed. The ratio is terminals per fire, so it moves with the
        // records each fire imported. The old description called it "a constant OF THIS WORKFLOW";
        // a model taught that reports a load change as a fault.
        var description = PanelRegistry.All.Single(p => p.PanelId == "run-boundaries").Description;

        Assert.Contains("NO FIXED RATIO", description, StringComparison.Ordinal);
        Assert.Contains("graph", description, StringComparison.Ordinal);
        Assert.Contains("drained", description, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("entered", description, StringComparison.Ordinal);
        Assert.DoesNotContain("constant OF THIS WORKFLOW", description, StringComparison.Ordinal);
        Assert.DoesNotContain("1:6", description, StringComparison.Ordinal);
    }
```

- [ ] **Step 2: Run it to verify it fails**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Analyst.PanelRegistryTests"
```

Expected: `RunBoundariesTellsTheModelThereIsNoFixedRatio` fails on `NO FIXED RATIO`.

- [ ] **Step 3: Replace the description**

Replace the `Description:` argument of the `run-boundaries` `PanelDefinition` with:

```csharp
            Description:
                "Where this workflow's runs began and ended in the window. entry is the number of " +
                "fires that ENTERED in the window (distinct CorrelationIds with an entry record); " +
                "terminal is the number of branch ends belonging to those fires (terminal records " +
                "whose CorrelationId is one of them), however far each fire fanned out. A terminal " +
                "of a fire that entered before the window is not counted. The operator reads the " +
                "same two numbers as the run-boundaries pie on the Kibana board. " +
                "THERE IS NO FIXED RATIO between the two. A branch ends where no next step accepts " +
                "its outcome, and a fork multiplies the branches after it, so terminals per fire " +
                "follow from the workflow's graph AND from how many records each fire imported: the " +
                "same healthy workflow reads about 1:1 idle and many terminals per fire when busy. " +
                "Do NOT report a shortfall against an assumed ratio; the prompt describes the " +
                "target workflow's graph. " +
                "entry ABOVE ZERO WITH TERMINAL AT ZERO is the one unambiguous finding: the " +
                "workflow is alive -- the schedule fired, the leader held the lease, the gate was " +
                "open, the dispatch reached a queue -- and nothing completed. " +
                "drainedPolls out of importerPolls is how many fires sent nothing downstream. Such " +
                "a fire is NOT missing a terminal: the importer reports Cancelled, which the " +
                "orchestrator records as that fire's terminal, so an idle workflow sits near 1:1 " +
                "rather than at terminal zero. Never explain missing terminals with drainedPolls; " +
                "a fire with no terminal is work that started and did not finish. " +
                "entry AT ZERO means the workflow did not fire at all: stopped, no leader " +
                "dispatching, or the projection store gate shut. " +
                "A reading NOT fully covering the window here can also mean more runs touched the " +
                "window than the reading could hold; entry and terminal are then lower bounds. " +
                "Scoped to the target workflow by attributes.WorkflowId.",
```

Replace the comment block above the definition (`// THE AGENT'S COUNTERPART TO THE OPERATOR'S RUN-BOUNDARY PIE …`) with:

```csharp
        // THE AGENT'S COUNTERPART TO THE OPERATOR'S RUN-BOUNDARY PIE (skp-runposition-pie). Since
        // 2026-10-01 both count the same thing: fires that entered in the range, and every terminal
        // record of those fires. The pie does it in ES|QL; this panel does it with a terms join on
        // CorrelationId, because ElasticPanelSource reads _search. Keep the two in step -- the
        // maintenance rule above is the only thing that detects drift between them.
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Analyst.PanelRegistryTests"
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Analyst.ToolCatalogTests"
```

Expected: 0 failed. `ToolCatalogTests` covers any length budget on descriptions; if it fails on length, shorten the description, not the test.

- [ ] **Step 5: Full hermetic suite**

```bash
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe
```

Expected: 0 failed, exit 0, every skip under `Live/`.

- [ ] **Step 6: Commit**

```bash
git add src/Processor.Analyst/Panels/PanelRegistry.cs src/tests/BaseApi.Tests/Analyst/PanelRegistryTests.cs
git commit -m "feat(analyst): run-boundaries description says there is no fixed ratio

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The prompt carries the target workflow's graph

**Files:**
- Modify: `tools/analyst-prompt-v7.txt` (corrected to the live prompt before this change)
- Create: `tools/analyst-prompt-v8.txt`

**Interfaces:**
- Consumes: the live `analyst-monitor-cfg` payload (BaseApi `GET /api/v1/assignments`); `PromptStructure` (`src/Processor.Analyst/Bit/PromptStructure.cs`) for the structure check.
- Produces: `tools/analyst-prompt-v8.txt`, which Task 5 publishes.

- [ ] **Step 1: Write v7 and v8 from the live prompt**

The script reads the live prompt, writes it to v7 unchanged, then builds v8 by replacing the one run-boundaries bullet with the bullets below. It refuses to run unless exactly one line starts with `- run-boundaries `.

```bash
python - <<'EOF'
import json, urllib.request
asg = [a for a in json.load(urllib.request.urlopen("http://localhost:18080/api/v1/assignments"))
       if a["name"] == "analyst-monitor-cfg"]
assert len(asg) == 1, asg
live = json.loads(asg[0]["payload"])["prompt"].replace("\r\n", "\n")
open("tools/analyst-prompt-v7.txt", "w", encoding="utf-8", newline="\n").write(live + "\n")

NEW = [
    "- run-boundaries: entry is the fires that entered in this window; terminal is every branch end of those fires, however far they fanned out. Terminals of fires that entered before the window are not counted. There is no fixed ratio between the two: terminals per fire follow from this workflow's graph and from how many records each fire imported, so a busy window and an idle one read very differently and both are healthy. The one unambiguous finding is entry above zero with terminal at zero - fires go out and nothing ends. Never explain that away with drainedPolls: an importer poll that finds nothing reports Cancelled, which is that fire's terminal, so a fire with no terminal is work that started and did not finish. Entry at zero means the workflow did not fire.",
    "- THE GRAPH OF THIS WORKFLOW (filefetcher-archiveexpander-chain, as of 2026-10-01) decides what the business panels should show. Each record the importer reads follows one path: a good record forks at sk-normalizer-sample into two branches that both end at split-exporter, so it ends twice; a record that fails at any step goes to record-outcome and then export-outcome and ends once; a record that is cancelled (its artist is not on the whitelist) ends once, where it was cancelled. An importer poll that reads nothing ends once, as Cancelled.",
    "- From that graph: run-boundaries terminal, minus step-outcomes Failed, minus step-outcomes Cancelled, is twice the number of good records, so it is even and not negative. A few either way can come from runs that straddle the window edges; a larger shortfall is branches that started and did not end.",
    "- From that graph: step-outcomes Completed is not a success rate. A good record contributes eleven Completed records, because the steps after the fork run twice, and every failure adds two more in record-outcome and export-outcome, so the Completed share moves with the mix of records, not with health.",
    "- The graph is the definition as it stands now. A run uses the definition from its workflow's last start, so a recent edit can put the graph ahead of the run. What a step does inside it, such as which step can cancel and why, is not in the graph.",
]
lines = live.split("\n")
idx = [i for i, l in enumerate(lines) if l.startswith("- run-boundaries ")]
assert len(idx) == 1, idx
v8 = "\n".join(lines[:idx[0]] + NEW + lines[idx[0] + 1:])
open("tools/analyst-prompt-v8.txt", "w", encoding="utf-8", newline="\n").write(v8 + "\n")
print("v7", len(live), "chars; v8", len(v8), "chars")
EOF
```

Expected: both files written; v8 about 1,900 characters longer than v7.

- [ ] **Step 2: Check the new bullets sit inside STAGE 4**

```bash
grep -n "^STAGE \|^- THE GRAPH\|^- run-boundaries" tools/analyst-prompt-v8.txt
```

Expected: the `- run-boundaries:` and `- THE GRAPH` lines fall between the `STAGE 4 - EXECUTE` and `STAGE 5 - VERIFY` lines.

- [ ] **Step 3: Run the deterministic structure check on v8**

Add this test to `src/tests/BaseApi.Tests/Analyst/PromptStructureTests.cs`. `PromptStructure.Check(string)` returns `IReadOnlyList<StageProblem>`, and an empty list is a pass, which is how the existing tests in that class assert it. The repo root is found by walking up to `SK_P.sln`:

```csharp
    [Fact]
    public void ThePublishedV8PromptHasAllFiveStages()
    {
        var root = AppContext.BaseDirectory;
        while (!File.Exists(Path.Combine(root, "SK_P.sln")) && Directory.GetParent(root) is { } parent)
        {
            root = parent.FullName;
        }

        var prompt = File.ReadAllText(Path.Combine(root, "tools", "analyst-prompt-v8.txt"));

        Assert.Empty(PromptStructure.Check(prompt));
    }
```

Run:

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Analyst.PromptStructureTests"
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tools/analyst-prompt-v7.txt tools/analyst-prompt-v8.txt src/tests/BaseApi.Tests/Analyst/
git commit -m "feat(analyst): prompt v8 carries the target workflow's graph; v7 corrected to the live prompt

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Dev rollout

This spends real model credit: the next `analyst-monitor` fire re-runs the BIT on the new prompt hash (one judge call set plus two full rehearsal investigations), then the investigation itself.

**Files:** none changed in the repo.

**Interfaces:**
- Consumes: Tasks 2 to 4.
- Produces: the deployed Analyst and the published v8 prompt.

- [ ] **Step 1: Build, read the new SourceHash, repoint the existing processor row**

Run in `pwsh` (Windows PowerShell 5.1 cannot load a .NET 8 assembly):

```powershell
dotnet build src/Processor.Analyst/Processor.Analyst.csproj
$asm  = [Reflection.Assembly]::LoadFrom((Resolve-Path "src/Processor.Analyst/bin/Debug/net8.0/Processor.Analyst.dll"))
$hash = ($asm.GetCustomAttributes([Reflection.AssemblyMetadataAttribute], $false) |
         Where-Object { $_.Key -eq 'SourceHash' }).Value
$b    = "http://localhost:18080/api/v1"
$step = (Invoke-RestMethod "$b/steps") | Where-Object { $_.name -eq 'analyst-monitor' }
$id   = $step.processorId
$cur  = Invoke-RestMethod "$b/processors/$id"
"repointing $($cur.name) $id from $($cur.sourceHash) to $hash"
$body = @{ name=$cur.name; version=$cur.version; description=$cur.description; sourceHash=$hash
           inputSchemaId=$cur.inputSchemaId; outputSchemaId=$cur.outputSchemaId
           configSchemaId=$cur.configSchemaId } | ConvertTo-Json
Invoke-RestMethod -Method Put "$b/processors/$id" -ContentType application/json -Body $body
```

Expected: one `analyst-monitor` step found; the PUT returns the row with the new hash. The update DTO needs every field, so the GET-and-resend shape is required.

- [ ] **Step 2: Build the image, load it into kind, roll the deployment**

```bash
docker build -f src/Processor.Analyst/Dockerfile -t processor-analyst:local .
kind load docker-image processor-analyst:local --name desktop
kubectl -n skp rollout restart deploy/processor-analyst
kubectl -n skp rollout status deploy/processor-analyst --timeout=180s
```

Confirm the image tag matches `k8s/43-processor-analyst.yaml` before building (`grep image: k8s/43-processor-analyst.yaml`). The cluster is kind (`desktop`) even though the context says `docker-desktop`; without `kind load` the pods restart on the old binary.

- [ ] **Step 3: Publish the v8 prompt through BaseApi**

```bash
python - <<'EOF'
import json, urllib.request
B = "http://localhost:18080/api/v1"
a = [x for x in json.load(urllib.request.urlopen(f"{B}/assignments")) if x["name"] == "analyst-monitor-cfg"][0]
p = json.loads(a["payload"])
p["prompt"] = open("tools/analyst-prompt-v8.txt", encoding="utf-8").read().rstrip("\n")
body = {k: a[k] for k in ("name", "version", "description", "stepId")} | {"payload": json.dumps(p)}
req = urllib.request.Request(f"{B}/assignments/{a['id']}", data=json.dumps(body).encode(), method="PUT",
                             headers={"Content-Type": "application/json"})
print(urllib.request.urlopen(req).status)
EOF
```

Expected: `200`.

- [ ] **Step 4: Restart `analyst-monitor` so its start projects the payload**

```bash
W=$(curl -s localhost:18080/api/v1/workflows | python -c "import json,sys; print([w['id'] for w in json.load(sys.stdin) if w['name']=='analyst-monitor'][0])")
for v in stop start; do curl -s -o /dev/null -w "$v %{http_code}\n" -X POST -H 'Content-Type: application/json' -d "\"$W\"" localhost:18080/api/v1/orchestration/$v; done
```

Expected: `stop 202`, `start 202`.

- [ ] **Step 5: Watch the next fire**

The cron is `0 9,39 * * * *`. After the next :09 or :39, read the Analyst's own records in Elasticsearch (service `processor-analyst`, last 30 minutes) for the BIT verdict and the step outcome:

```bash
curl -s 'localhost:19200/_query?format=txt' -H 'Content-Type: application/json' -d '{"query":"FROM logs-generic.otel-default | WHERE @timestamp >= NOW() - 30 minutes AND resource.attributes.service.name == \"processor-analyst\" | KEEP @timestamp, severity_text, body.text | SORT @timestamp | LIMIT 200"}'
```

Expected: the BIT runs (structure, judge, rehearsal) and the dispatch ends Completed or with a finding. A single UNFIT from the judge is not a verdict: it passes the same prompt 50 to 90 percent of the time, and the next roll re-runs it. If the dispatch fails on the token ceiling, report the token count; the prompt grew by about 1,900 characters.

- [ ] **Step 6: Ship delta**

Read the header of `tools/ship-delta.ps1` for its usage, run it, and confirm the delta lists `src/Processor.Analyst/` (the image) and `tools/analyst-prompt-v8.txt`. The offline machine also needs the payload PUT (Step 3) and the workflow restart (Step 4) after its image is loaded.

---

## Self-review

- **Spec coverage:** §3 (panel follows the pie) → Task 2. §4 (graph via prompt; checks limited to the Analyst's panels) → Task 1 (amendment) and Task 4. §5 (description; prompt; v7/v8 files) → Tasks 3 and 4. §6 (rehearsal fixture unchanged) → Global Constraints (field names kept; `RehearsalPanels` untouched). §7 (out of scope) → no task touches the BIT, the dashboard or the persister. §8 (rollout) → Task 5.
- **Placeholders:** none; `PromptStructure.Check`, `SK_P.sln`, the `processor-analyst` deployment and image, the `analyst-monitor` step and the `RunPositions` values were all checked against the repo and BaseApi.
- **Type consistency:** `RunsFor(TimeRange) : int` is defined in Task 2 Step 5 and used in Task 2's tests; the response names `by_run`, `entered_runs`, `entered_terminals` match between the query (Step 4), the parser (Step 6), the fixtures (Step 1) and the registry test (Step 2).
- **Review Focus:** each of the five lines names the test that pins it.
