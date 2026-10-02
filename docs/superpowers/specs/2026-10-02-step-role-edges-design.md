# StepRole on the run's edges only

Date: 2026-10-02. Status: approved by the user in conversation; supersedes the role model of
`2026-10-02-step-role-design.md` (D1, D3–D6 and the role-key storage). Nothing here is implemented.

## Goal

`StepRole` marks only the two edges of a workflow run: where work enters (an entry step is
dispatched) and where it leaves the graph (a step with no successors returns an outcome). There is
no `intermediate`. The Kibana pie and the Analyst's `run-boundaries` panel read those two edges.

## Why the earlier model is replaced

The shipped model (role keys written by BaseApi, a resolver in the framework, three values on every
outcome record) put a graph role on every step. The user's design is edges only. With one looked-up
value left (`terminal`), a per-workflow key in L2 costs more than it gives: a Redis read per outcome,
a cache that must be dropped at each start, and a state ("workflow not restarted since the deploy")
in which records silently lose the attribute. The orchestrator already holds each workflow's graph.

## Decisions

| # | Decision |
|---|---|
| E1 | Two values, lowercase: `entry`, `terminal`. Log scope key `StepRole`, constants in `Messaging.Contracts.StepRoles`. `intermediate` is removed. |
| E2 | `entry` is hardcoded on the scheduler's `"dispatched an entry step"` record (`WorkflowFireJob`), written only after a successful send. One record per entry step dispatched, not per fire: a fire that dispatches two entry steps writes two `entry` records under one correlation id. The frozen skip and a failed send carry nothing. |
| E3 | `terminal` is stamped by `StepOutcomeHandler` on the outcome record of a step that has **no successors in this workflow's graph**, whatever the result (Completed, Failed, Cancelled). The test is `completed.NextStepIds` empty on the `StepL1` the handler already looked up from its L1 store for the message's `WorkflowId`. It is the graph fact, not the run-time "no successor accepted this result". |
| E4 | No other record carries `StepRole`: not an entry step's outcome, not a step whose successors declined its result, not the "advanced" or "advancing … on a {Result} step" lines, not the handoff. |
| E5 | A step shared by two workflows is classified per workflow, because the step comes from that workflow's L1 entry. |
| E6 | A step that is both entry and terminal (a single-step workflow): its dispatch carries `entry`, its outcome carries `terminal`. |
| E7 | BaseApi writes no role keys. The `skp:wf:{w}:step:{s}` keys, `StepRoleClassifier`, `L2ProjectionKeys.StepRole`/`RoleField`, `IStepRoleSource`, `RedisStepRoleSource`, `StepRoleResolver` and its `Forget` call are deleted. Keys already written on dev are removed once by hand at deploy. |
| E8 | The Kibana pie: fires that entered in the selected range (any `entry` record), then every `StepRole` record of those fires counted by `StepRole` (inner ring: entry, terminal) and `StepName` (outer ring). Metric `records`. |
| E9 | The Analyst `run-boundaries` panel reads the same two edges plus the importer's intake, and keeps the workflow-scope trust rule (no records of the workflow at all = not distinguishable). The "roles not written" state no longer exists, so `roleRecords` is removed. |

## What the edges mean

- `entry` counts dispatches: per entry step, how many times a fire sent it work. With one entry
  step it equals `fires`.
- `terminal` counts outcomes at steps with no successors, by step name. Failures and cancellations
  that end a branch at a step with successors are not edges and are not counted here; the gap
  between what entered and what reached the terminal steps is where they went (the `step-outcomes`
  and `step-failures` panels hold the per-result detail).
- A stall shows as `entry` records with no (or too few) `terminal` records. A fire whose entry step
  never returns is visible again: it has its dispatch record.
- Example (the `endless-feed-steprole` window, 15 fires, 125 items imported): `entry` 15
  (split-importer); `terminal` 75 export-outcome + 75 record-outcome. Verified figures come from the
  recapture after deployment, not from this example.

## Analyst panel

`run-boundaries` value:
`{ totalWorkflowRecords, fires, importerPolls, pollsThatImported, drainedPolls, recordsImported, byStep: [{ role, step, records }] }`

- Statement 1: `totalWorkflowRecords` (every record of the workflow in the window), `fires`
  (distinct correlation ids among `entry` records), `earliest` (first `entry` record, for coverage).
- Statement 2: the edge counts, by role and step, for fires that entered in the window.
- Statement 3: importer polls, `drainedPolls`, and `recordsImported` = sum of `attributes.Consumed`,
  so items in can be set against terminal outcomes out.
- Trust: `totalWorkflowRecords` 0 → all flags false; otherwise `SeriesPresent` and
  `NoDataDistinguishable` true, `WindowFullyCovered` from `earliest`. A partial ES|QL response is
  unavailable (unchanged).
- Prompt v12 (from v11): hypothesis 3 and the stage-4 bullet rewritten for edges; the primer's
  run-boundaries bullet likewise. `RehearsalPanels` and the replay plants move to the new shape.
- Replay: a new capture `endless-feed-edges` after deployment; the scenarios skip until it exists.

## Out of scope

Per-step counts between the edges (the `step-outcomes` panel is unchanged); per-result terminal
breakdown; the BIT's return to Full mode.

## Testing

- Orchestrator: dispatch record carries `entry` (and only after a successful send); a fire with two
  entry steps writes two `entry` records, one correlation id; a terminal step's Completed, Failed
  and Cancelled outcomes carry `terminal`; a step with successors that declined the result carries
  nothing; an entry step's outcome carries nothing; a step shared by two workflows is terminal in
  one and unstamped in the other.
- Removal: no `StepRoleResolver`, role key or `Intermediate` remains in `src/`; the full suite passes.
- Kibana: the checker pins the new query, groups and metric.
- Analyst: fixtures for healthy, stalled (entry only), no-records, partial; v12 structure test.
- Dev: after deploy, records show `entry` only on dispatches and `terminal` only on terminal steps'
  outcomes; the pie and the panel agree with a feed window's answer key.
