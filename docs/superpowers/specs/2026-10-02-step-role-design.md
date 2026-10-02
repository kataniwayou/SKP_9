# StepRole: a step's place in its workflow, replacing RunPosition

Date: 2026-10-02. Status: design, awaiting review. Nothing here is implemented.

## Goal

Replace the run-time `RunPosition` attribute (`entry` on a fire's dispatch, `terminal` on an outcome
no successor accepts) with `StepRole`, a property of the workflow's graph: whether a step is the
workflow's entry, a terminal, or an intermediate step. Show it as a two-ring pie that reads as a
funnel — how much of a window's work reached each step — and give the Analyst the same funnel.

Success: on a known window the pie's per-step counts equal what the input implies. Checked
2026-10-02 on the `busy-mixed-feed` window (19:08–19:23Z) with stand-in data: 15 / 125 / 107 / 89 /
53 / 106 / 106 / 106 / 54 / 54, every figure matching the window's verified answer key.

> **Note (2026-10-02, after deploy).** The leading 15 came from stand-in data, which counted the
> scheduler's dispatch records (one per fire). The shipped query counts the importer's outcome
> records. On a real window the entry slice is records imported plus one Cancelled record per empty
> poll, and it equals fires only when each poll imports one record or none. Verified on
> `endless-feed-steprole` (12:57:45–13:12:45Z): 15 fires, entry 125 = 125 records imported, 0 empty
> polls; graph order 125 / 125 / 100 / 75 / 25 / 50 / 50 / 50 / 75 / 75 (Task 8 report).

## Decisions

| # | Decision |
|---|---|
| D1 | Three roles. `entry`: the step is in the workflow's `entryStepIds`. `terminal`: the step has no successors (empty `nextStepIds`). `intermediate`: every other step. |
| D2 | Roles are per workflow. A step shared by two workflows may be `terminal` in one and `intermediate` in the other, so the role never lives on the global step key `skp:step:{id}`. |
| D3 | BaseApi computes the roles when it writes a workflow's projection (at start) and stores one key per step: `skp:wf:{workflowId}:step:{stepId}`, a HASH with field `role`. |
| D4 | A step removed from the workflow has its role key deleted at the next start, unconditionally (it belongs to this workflow alone). Keys are kept on stop, as names are: records keep arriving after a stop. |
| D5 | The orchestrator stamps `StepRole` at exactly two points, both resolving the role from the D3 key for the step concerned: (1) the scheduler, on the record of each entry-step dispatch; (2) outcome handling, on the record written when a step returns any outcome (Completed, Failed or Cancelled). Nothing in the orchestrator derives a role itself. |
| D6 | The role is the step's static role regardless of the outcome: an intermediate step that cancels is stamped `intermediate`. |
| D7 | The Kibana pie: first the correlation ids of fires that entered in the selected time range, then those fires' outcome records counted by `StepRole` (inner ring) and `StepName` (outer ring). Only outcome records are counted; the scheduler's entry record only decides which fires entered. |
| D8 | The Analyst's `run-boundaries` panel becomes the same funnel. |
| D9 | `RunPosition` is removed entirely: contract, emitters, pie, Analyst panel, prompt, tests. |
| D10 | The `ends-not-recorded` replay scenario is deleted: with no run-end records, the fault it tested no longer exists. |

## What a role means, and what it does not

`StepRole` describes where a step sits in the graph, not what happened to a run. `terminal` means
"a step with no successors returned an outcome", not "a branch ended here": a good item's branch
ends at an intermediate step whose Completed result nothing accepts, and a cancellation ends a
branch at whatever step cancelled. Those ends are not counted anywhere; they show as the drop
between a step's count and its successors' counts.

Example from the captured window: sk-normalizer-sample returned 89 outcomes (53 Completed, 18
Failed, 18 Cancelled), all in its slice under `intermediate`. Its successors then show 53 (the two
fork branches) and record-outcome receives its 18 failures; the 18 cancellations are the gap.

Applied to `filefetcher-archiveexpander-chain`: split-importer is `entry`, export-outcome is
`terminal`, the other eight steps are `intermediate`.

## Storage and lifecycle (BaseApi)

- **Where:** `L2ProjectionWriter`, in the same batch that writes `skp:wf:{id}`'s `store` field, so a
  start writes the graph and its roles together.
- **Key:** `skp:wf:{workflowId}:step:{stepId}`, HASH, field `role`, value `entry` | `intermediate`
  | `terminal`. Added to `L2ProjectionKeys` beside `Cache`/`CacheEntry`; it nests under the
  workflow's prefix, so it cannot collide with another kind's key.
- **Computation:** from the projection being written: `entryStepIds` and each step's `nextStepIds`.
  A step that is both an entry step and a successor of another step is `entry` (known behaviour, not
  special-cased: no graph in use has this shape).
- **Deletion:** `FindRemovedStepsAsync` already computes the steps present in the previous
  projection and absent from the new one. Their role keys join the stale set deleted first in the
  batch, with no check of the step row (unlike the shared name key, which is deleted only when the
  row is gone).
- **On stop:** nothing is deleted.
- **Edits:** a role reflects the graph at the last start; an edit takes effect at the next start,
  like every other part of the projection.

## Stamping (orchestrator)

- **Resolution:** through the framework's name resolver (`EntityNameResolver`), which gains a role
  lookup keyed by (workflow, step), read from the D3 key and cached like names. The cache must not
  outlive a start: a restarted workflow can change roles, so the cached roles for a workflow are
  dropped when the orchestrator re-reads that workflow's projection.
- **Point 1, scheduler (`WorkflowFireJob`):** where `RunPositions.Entry` is scoped today, scope
  `StepRole` = the resolved role of the entry step being dispatched.
- **Point 2, outcome handling (`StepOutcomeHandler`):** the handler writes exactly one record per
  returned outcome (the "no successor accepts it" line or the "advanced" line). Both carry
  `StepRole` = the resolved role of the step that returned, replacing today's `RunPositions.Terminal`
  scope on the first.
- **Missing key:** a role that cannot be resolved (key absent, store unreachable) is omitted from
  the record, never guessed; the omission is logged once per (workflow, step), like a missing name.
- **Log scope key:** `StepRole`, surfacing at `attributes.StepRole` through the same
  `IncludeScopes` + `ParseStateValues` bridge that carries `RunPosition` today. The constant lives in
  `Messaging.Contracts` (the dashboard and the Analyst select on it and share no compiler with the
  emitter), replacing `RunPositions`.
- **Outer-ring name:** the outcome record must carry the returning step's `StepName`. Orchestrator
  records carry `StepName` today; the plan verifies the outcome record specifically.

## Kibana pie

An ES|QL Lens pie, replacing the current "Run boundaries — entered fires and their terminals" panel:

```
FROM logs-generic.otel-default
| WHERE attributes.StepRole IS NOT NULL AND attributes.WorkflowName == ?workflow
| EVAL entered = CASE(attributes.StepRole == "entry", 1, 0),
       counted = CASE(attributes.`{OriginalFormat}` IN (<the two outcome-handler templates>), 1, 0)
| INLINE STATS fire_entered = MAX(entered) BY attributes.CorrelationId
| WHERE fire_entered == 1 AND counted == 1
| STATS outcomes = COUNT(*) BY attributes.StepRole, attributes.StepName
```

`entered` may come from either `entry` record of the fire (the scheduler's, or the entry step's
outcome); both carry the fire's correlation id. `counted` selects the outcome handler's records by
their two message templates, which move into `Messaging.Contracts` beside the `StepRole` key for the
same reason `RefusalTemplates` live there: the pie and the Analyst select on text the orchestrator
writes.

Inner ring `StepRole`, outer ring `StepName`. The time range is the dashboard's; a fire that
entered just before the range end loses the outcomes that land after it, as today's pie does.

Verified 2026-10-02 on dev (Elasticsearch and Kibana 9.3.4): `INLINE STATS` runs, and the query
shape, with roles derived from existing records, reproduces the window's answer key.
**Not yet verified:** that a Lens pie over an ES|QL source renders two rings from two "slice by"
dimensions. The plan's first task checks it; if it cannot, the fallback is a treemap or a
stacked bar with the same query.

`tools/verify-kibana-dashboard.py` and `docs/testing/kibana-panels-through-the-graph.md` are updated
with the panel. The offline machine runs the same 9.3.4, so the saved object ships unchanged.

## Analyst

- **Panel:** `run-boundaries` becomes the funnel: the D7 query's result as
  `{ totalWorkflowRecords, fires, byStep: [{ role, step, outcomes }] }`, with the trust flags it has
  today (window coverage, a capped reading). `pollsThatImported`/`drainedPolls` are kept: they come
  from importer records, not `RunPosition`. The description is rewritten around the funnel: a
  step's count against its predecessors' is where items dropped, and a stall is the funnel stopping
  after `entry`.
- **Gain:** the per-step dimension the Analyst has lacked. Claims like "the failures sit at these
  three steps" become checkable against counts rather than inferred from five samples.
- **Loss (accepted):** "branches ended but their ends were not recorded" is no longer detectable,
  because nothing records ends.
- **Prompt and contract:** prompt v10's hypothesis "fires enter but branches do not end" and its
  run-boundaries definitions are rewritten for the funnel, and the framework primer's
  entry/terminal rules likewise. That makes a new prompt version (v11).
- **BIT:** `RehearsalPanels` gets a funnel reading in place of `{entry, terminal}`.
- **Replay:** `ends-not-recorded` is deleted (D10). `stall` is redefined as the funnel stopping
  after `entry`. The `busy-mixed-feed` capture has no real `StepRole` values; after deployment a new
  window is captured with the feed running and its answer key verified as before. Until then the
  replay scenarios that read the funnel stay skipped; no hand-built reading stands in for a capture.

## Removals (D9)

`Messaging.Contracts/RunPositions.cs`; its uses in `WorkflowFireJob` and `StepOutcomeHandler`;
`ExecutionRoundTripTests` and `WorkflowFireJobTests` assertions on it; the Kibana panel and the
dashboard's `attributes.RunPosition:*` query clause; the Analyst panel's run-position join; prompt
v10's and the primer's text about it; the replay fixture's `run-boundaries.json`. Historical prompt
files (v0–v9) and dated plans/specs stay as history.

## Order of work

1. Spike: Lens two-ring pie over ES|QL on dev (read-only until approved to save).
2. BaseApi: compute, write and delete the role keys; `L2ProjectionKeys` entry.
3. Framework: resolver role lookup and cache invalidation; repack the packages.
4. Orchestrator: stamp at the two points; remove `RunPosition`.
5. Kibana: the pie, its checker and its doc.
6. Analyst: the funnel panel, primer, prompt v11, `RehearsalPanels`; delete `ends-not-recorded`.
7. Deploy to dev; capture a new replay window; verify its answer key; re-enable the scenarios.
8. Offline change set and runbook updates.

## Testing

- **BaseApi:** the roles of a known graph; a step shared by two workflows with different roles;
  a removed step's key deleted at the next start, the shared name key's own rule unchanged; nothing
  deleted on stop.
- **Resolver:** role resolved and cached; dropped after a start; a missing key omitted, not guessed.
- **Orchestrator:** the entry record and every outcome record carry the resolved role, including a
  Cancelled outcome at an intermediate step; no `RunPosition` remains anywhere.
- **Kibana:** the checker verifies the panel's query and its two dimensions.
- **Analyst:** the funnel panel parses a captured reading; the full suite and the replay scenarios
  once the new capture exists.

## Out of scope

Branch-end counting of any kind; per-step timing; the Analyst's other panels; the BIT's return to
Full mode (planned separately, before the monitor goes onto its cron).
