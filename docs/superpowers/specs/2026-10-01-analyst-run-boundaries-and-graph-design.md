# Spec: Analyst run boundaries follow the operator pie, and the Analyst reads the workflow graph

Status: draft 2026-10-01, for approval. Extends `2026-09-24-analyst-processor-design.md` §7 (the panel
tool surface). Nothing here is implemented.

## 1. Why

On 2026-10-01 the operator's run-boundary pie (`skp-runposition-pie`, commit 9567e9f) changed from two
independent record counts to an ES|QL join: **entry** is every CorrelationId with an entry record in
the range, **terminal** every branch end whose CorrelationId is one of those fires.

The Analyst's `run-boundaries` panel still counts records the old way. That breaks two rules of the
analyst design:

- **§7:** "The agent gets the same curated views the operator gets." The two now show different
  numbers for the same window.
- **§7.3:** "the panel set is a correctness dependency of the Analyst." The panel description and the
  live prompt both teach a false rule: "the healthy ratio is a constant OF THIS WORKFLOW … 1:2, 1:6".

**The ratio is not a constant of the workflow.** Measured on `filefetcher-archiveexpander-chain` on
2026-10-01: about 1:1 idle (60 entry / 59 terminal), 5 : 90 with the approved feed at a 60s cron. What
is constant is the number of terminals **per input record**, and only the workflow graph says what
that is. An agent taught a fixed ratio would report a load change as a fault, and it has no way to
derive the right expectation, because the graph is not among its panels.

## 2. Terminals follow from the graph

A step's outcome becomes a **terminal** when none of the step's next steps accepts that outcome.
`entryCondition` decides acceptance (`StepEntryCondition`):

| value | name | accepts |
|---|---|---|
| 1 | PreviousCompleted | Completed |
| 2 | PreviousFailed | Failed |
| 3 | PreviousCancelled | Cancelled |
| 4 | Always | every outcome |
| 5 | Never | nothing (a frozen step) |
| 0 | PreviousProcessing | nothing (no step ever reports it; the validator refuses it) |

So, for each step, **terminal outcomes** = {Completed, Failed, Cancelled} minus the outcomes some next
step accepts. A step with no next steps is terminal on every outcome.

A fork, meaning a step with two next steps that accept the same outcome, multiplies the branches
downstream. In the chain, `sk-normalizer-sample` forks on Completed into `split-archivecollapser` and
`sk-normalizer-alphabeta`. A good file therefore ends twice (both at `split-exporter`), a failed file
once (at `export-outcome`, through the `record-outcome` sink), and a cancelled file once (where it
cancelled). An empty fire ends once, at the importer's Cancelled.

**Expected terminals per fire = the sum over the fire's records, or 1 when the fire imported nothing.**
This is the rule the agent must apply. It replaces every fixed ratio.

## 3. The `run-boundaries` panel follows the operator pie

`PanelRegistry` `run-boundaries` (Elastic kind) is rewritten to the pie's rule, scoped as today to the
target workflow by `attributes.WorkflowId` and to the dispatch window:

- **entry**: the distinct CorrelationIds with a `RunPosition = entry` record in the window.
- **terminal**: the count of `RunPosition = terminal` records whose CorrelationId is in that set.
  Terminals of fires that entered before the window are excluded.
- **drainedPolls / importerPolls**: unchanged.

The panel stays a `_search` body, because `ElasticPanelSource` reads `_search`. The join is a `terms`
aggregation on `attributes.CorrelationId` with `entry` and `terminal` filter sub-aggregations, a
`bucket_selector` keeping buckets with entry > 0, and `sum_bucket` over the kept terminals. The terms
`size` must cover every fire in the longest allowed window. At the one-second cron floor that is
`WindowMinutes × 60`, so it is set from the window rather than hard-coded, and a reading that hits the
size cap is flagged `WindowFullyCovered = false`, never silently truncated.

The run-position key and values stay substituted from `RunPositions` (`WithRunPositions`), as today.

## 4. A `workflow-graph` panel

A new panel, `workflow-graph`, layer `business`. The operator already sees the graph: it is the
published workflow diagram (`kibana/publish-diagram.py`, served at `/api/v1/workflows/{id}.svg`).
This gives the agent the same view, as data.

- **New kind `PanelKind.BaseApi`**, routed by `LivePanelReader` to a new `BaseApiPanelSource`. It
  issues GET requests only, to `/api/v1/workflows/{id}`, `/steps` and `/processors`. A new
  `Analyst__Panels__BaseApiBaseUrl` setting (`http://baseapi-service:8080`) is added to
  `k8s/43-processor-analyst.yaml`. The panel's `Query` holds no query; the source builds the reading
  from the target workflow id.
- **The reading** (`ValueJson`): the workflow name and cron, then, for every step reachable from the
  entry steps (breadth-first over `nextStepIds`, as `read_graph()` walks it), its name, processor
  name, `entryCondition`, next-step names, and its terminal outcomes per §2. Plus the derived
  per-record expectation where the graph fixes it: the fork points, and the terminals per record
  outcome (good, failed, cancelled).
- **Trust:** a graph is a definition, not a series. `SeriesPresent = true` when the workflow
  resolves, `WindowFullyCovered = true` (the graph has no time axis), `NoDataDistinguishable = true`.
  An unknown workflow or unreachable BaseApi throws `PanelUnavailableException`, like any other
  source.
- **A caveat the description must state:** the graph is the definition **as it is now**. A running
  workflow uses the definition from its last start (spec `2026-09-30-l2-start-driven-projection`
  §1.5), so an edit since then makes the graph ahead of the run. The rows also carry wiring, not
  meaning: which step can cancel, and why, lives in the handlers (see the header of
  `publish-diagram.py`).
- `workflow-graph` is added to the `analyst-monitor-cfg` panel set.

## 5. Description and prompt

**`run-boundaries` description** is rewritten to:
- define entry and terminal as in §3;
- state that no fixed ratio exists, and that expected terminals per fire come from `workflow-graph`
  (§2) and the importer's record count;
- keep the zero rules: entry above zero with terminal at zero is the one unambiguous finding; an
  empty poll ends as Cancelled and is that fire's terminal; entry at zero means the workflow did not
  fire;
- drop the claim that the operator reads "the same two counts" as records, and the "1:2 / 1:6"
  examples.

**The live prompt** (`analyst-monitor-cfg` payload) has its run-boundaries line replaced to match, and
gains one line telling the agent that `workflow-graph` is the reference for reading `step-outcomes`
volumes and `run-boundaries` ratios. The five-stage structure is not touched: `workflow-graph` is one
more unread panel the plan stage may name.

`tools/analyst-prompt-v7.txt` is replaced with the live prompt after the update. It is stale today: it
differs from the live payload on the run-boundaries line.

## 6. Rehearsal fixture

Only kept valid, not extended (the user's decision, 2026-10-01). `RehearsalPanels` must serve every
panel in the set, so it gains a `workflow-graph` fixture: a small fixed graph consistent with its
existing clean `run-boundaries` reading (`entry 30 / terminal 30`, `drainedPolls 0`), for example a
linear graph with one terminal per record. No new scenario is added, so the BIT still cannot catch a
wrong reading of run boundaries. That limitation is accepted.

## 7. Out of scope

- The BIT's exam, judge and scenarios (§8 of the analyst design).
- The operator dashboard. It already has the new pie.
- The AlphaBeta branch persisting a bare `track01.xml` under one shared name. That is a separate
  finding, not touched here.

## 8. Rollout

1. Code: `PanelKind.BaseApi`, `BaseApiPanelSource`, the `run-boundaries` query and description, the
   `workflow-graph` definition, the rehearsal fixture; unit tests for the terminal rule (§2) and for
   the join's size cap (§3).
2. Hermetic suite: 0 failed, exit 0.
3. Rebuild the Analyst image, `kind load`, repoint its SourceHash, roll the deployment.
4. PUT `analyst-monitor-cfg` through BaseApi (new prompt and panel set), then stop and start
   `analyst-monitor` so the start projects the payload.
5. Watch the next fire: the BIT runs again on the new prompt hash (structure, judge, rehearsal). The
   judge passes the same prompt 50 to 90 percent of the time, so a single UNFIT is not a verdict;
   the next roll re-runs it.
6. Sync `tools/analyst-prompt-v7.txt`; add the changed files to the offline ship delta.
