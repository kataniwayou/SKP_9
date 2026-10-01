# Spec: Analyst run boundaries follow the operator pie, and the Analyst reads panels through the graph

Status: draft 2026-10-01, revised the same day, for approval. Extends
`2026-09-24-analyst-processor-design.md` §7 (the panel tool surface). Nothing here is implemented.
The graph analysis it rests on is `docs/testing/kibana-panels-through-the-graph.md`.

Revision: the first draft added a `workflow-graph` panel backed by BaseApi. That was not the intent
and is withdrawn. The graph is knowledge the Analyst needs in order to read the panels, not another
panel to read (§4).

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
derive the right expectation, because it is never told the graph.

The same holds for every panel, not only this one. The analysis shows that each board's numbers are a
function of the graph and of what each fire imported, exactly, across three verified windows: the
fork doubles everything after `sk-normalizer-sample`, the failure sink repeats every Failed twice as
Completed, and a cancel ends where it happens.

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

## 4. The graph reaches the Analyst through its prompt

**No new panel and no new panel kind.** The Analyst needs the graph to read the panels, not as one
more reading. Each `analyst-monitor` assignment already targets one workflow (`targetWorkflowId`), and
its prompt is per assignment, so the graph facts for that workflow belong in the prompt.

What goes in, for `filefetcher-archiveexpander-chain` (from the analysis, §1 to §3):
- **The three shapes:** the fork at `sk-normalizer-sample` (everything after it runs twice per good
  record), the failure sink (`record-outcome` then `export-outcome`, once per Failed), and that a
  cancel ends at the step that cancelled. Plus the importer: one Completed per record, and one
  Cancelled per empty poll.
- **The expectation they give, limited to what the Analyst's panels show.** Its `step-outcomes`
  panel returns totals by result, not per step, and it has no whitelist panel, so the per-step checks
  in the analysis (post-fork at 2× alphabeta, Unlisted equal to the sample normalizer's Cancelled)
  are operator-only. The one check its panels support: **run-boundaries terminal − step-outcomes
  Failed − step-outcomes Cancelled = 2 × good records**, so it is even and not negative, give or take
  runs that straddle the window edges. Verified on all three analysis windows (225 − 111 − 40 = 74;
  1069 − 0 − 69 = 1000; 60 − 0 − 60 = 0). Plus: the Completed share of `step-outcomes` is not a
  success rate (11 Completed per good record, 2 more per failure).
- **Its limits:** the graph is the current definition and the run may still be on an older one; the
  handler facts (only the sample normalizer has a whitelist; triple fails before the lookup) are
  measured, not derivable from the rows.

These facts are **evidence about meaning, not observations of the window**, so they do not conflict
with the five-stage rule that a criterion may only name an unread panel. A criterion can be written as
"`split-exporter` is not 2× `sk-normalizer-alphabeta`", which names panels, not the prompt.

**Keeping them true.** The graph lives in BaseApi; the prompt copy can drift when the workflow is
edited. The prompt states the date and the graph it was written against, and a workflow edit that
changes the graph's shape requires the prompt to be revised with it. `publish-diagram.py` already
reads the live graph; extending it to print these facts is a possible follow-up, not part of this
change.

## 5. Description and prompt

**`run-boundaries` description** is rewritten to:
- define entry and terminal as in §3;
- state that no fixed ratio exists: expected terminals per fire follow from the workflow's graph (§2)
  and what each fire imported, which the prompt describes for the target workflow;
- keep the zero rules: entry above zero with terminal at zero is the one unambiguous finding; an
  empty poll ends as Cancelled and is that fire's terminal; entry at zero means the workflow did not
  fire;
- drop the claim that the operator reads "the same two counts" as records, and the "1:2 / 1:6"
  examples.

The description stays generic (it is compiled and shared by every workflow). Workflow specifics stay
in the prompt.

**The live prompt** (`analyst-monitor-cfg` payload) has its run-boundaries line replaced to match, and
gains the §4 graph section. The five-stage structure is not touched.

`tools/analyst-prompt-v7.txt` is corrected to the live prompt as it stands before this change (it
differs today on the run-boundaries line), and the new prompt is `tools/analyst-prompt-v8.txt`, so
the files keep one version each.

## 6. Rehearsal fixture

Unchanged (the user's decision, 2026-10-01). Its clean `run-boundaries` reading (`entry 30 /
terminal 30`, `drainedPolls 0`) is still a valid quiet window under the new rule: 30 empty polls, one
terminal each. No new scenario is added, so the BIT still cannot catch a wrong reading of run
boundaries. That limitation is accepted.

## 7. Out of scope

- The BIT's exam, judge and scenarios (§8 of the analyst design).
- The operator dashboard. It already has the new pie.
- Any new panel or panel kind.
- The AlphaBeta branch persisting a bare `track01.xml` under one shared name. That is a separate
  finding, not touched here.

## 8. Rollout

1. Code: the `run-boundaries` query and description in `PanelRegistry`; unit tests for the join's
   size cap (§3).
2. Hermetic suite: 0 failed, exit 0.
3. Rebuild the Analyst image, `kind load`, repoint its SourceHash, roll the deployment.
4. PUT `analyst-monitor-cfg` through BaseApi with the new prompt, then stop and start
   `analyst-monitor` so the start projects the payload.
5. Watch the next fire: the BIT runs again on the new prompt hash (structure, judge, rehearsal). The
   judge passes the same prompt 50 to 90 percent of the time, so a single UNFIT is not a verdict;
   the next roll re-runs it.
6. Commit `tools/analyst-prompt-v7.txt` (corrected) and `tools/analyst-prompt-v8.txt` (published);
   add the changed files to the offline ship delta.
