# Napole sections — Design

**Date:** 2026-11-09 · **Status:** draft for review · **Branch:** `feature/ems-exporter` (Napole merged 2026-11-09)
**Revises:** [2026-11-08-napole-design.md](2026-11-08-napole-design.md). That document stays the
authority for everything this one does not change, named per section below.

Napole today reports on a whole round trip, from the kafka-importer to any terminal step. This
revision makes it report on **any section of a workflow's graph**, named by two step ids: a start
step and an end step. The verdict for each execution is read from **step outcomes only**
(Completed, Failed, Cancelled), which the orchestrator writes for every step of every execution.
The report's fields and the hermetic identity do not change. One field, `reporterSubComponentName`,
now comes from the step payload instead of the pod, so each section's report names itself.

Sections marked **(decided)** are the user's decisions. *My call* marks a default the builder may
change without asking.

---

## 1. Why

One workflow can have several ends, and an operator may want a statement about part of it: "of the
files that reached the normalizer in this window, how many made it to the collapser". The first
version could not say that: it started at the kafka-importer's import record and ended at any step
tagged terminal, so a workflow with a failure-path exporter that *completes* (`export-outcome`) and
one entry processor other than the importer was out of reach. With a start and an end step in the
payload, one Napole step reports one section, and a workflow with two ends gets two Napole steps
and two reports **(decided)**.

## 2. Goals, non-goals, anti-goals

**Goals**
- One report per tick for one section `fromStepId → toStepId` of one workflow, with
  `outputCount + failedCount + discardedCount = inputCount` **(decided)**.
- Works for any entry processor (cron, fetcher, importer), not only the kafka-importer.
- The verdict uses only the orchestrator's step-outcome records and the step ids **(decided)**.

**Non-goals**
- Exact sections in branching graphs (§5.3). That needs the step graph, not only ES.
- Validating the ids against the workflow definition. The ids are the operator's responsibility
  **(decided)**.
- Everything the first design ruled out: per-execution findings in the output, catching up missed
  ticks, de-duplicating across ticks (2026-11-08 §2).

**Anti-goals**
- Counts that do not add up.
- An unfinished execution counted as anything.
- **Counting branch ends instead of executions (decided against, §5.4).**

## 3. Step payload (decided)

Five fields. *The names `fromStepId` and `toStepId` are my call* ("maybe generic names").

```json
{
  "watchedWorkflowId": "8cfdbcdb-a7e0-4a7d-9b4d-e4120ccacf02",
  "fromStepId": "95225f8c-56b2-494b-a59d-d9b34fbde441",
  "toStepId": "06f1c5fd-bdfc-43ae-93c9-5bde2995e167",
  "windowMinutes": 10,
  "reporterSubComponentName": "split-whole-run"
}
```

- All five are required. A missing payload, an empty GUID, `windowMinutes` < 1, or a missing,
  empty or whitespace-only `reporterSubComponentName` is a `FailedException`, as today. The config
  schema requires it too, with `minLength: 1`.
- **`reporterSubComponentName` names the section in the report (decided).** It is copied unchanged
  into `commonDimentions.reporterSubComponentName`. Two sections of one workflow cover the same
  window, so without it their reports would differ only in their counts. **The operator keeps the
  values unique (decided)**, as with the ids: Napole does not check that.
- `fromStepId` need not be the graph's first step, and `toStepId` need not be its last
  **(decided)**. `fromStepId == toStepId` is allowed: a one-step section (*my call*).
- **The operator owns the ids (decided)**, as they already own matching the cron to the window
  (2026-11-08 §5). In particular:
  - A wrong id makes the section match nothing, and the tick reports nothing (§6).
  - Pointing `toStepId` at a failure-path step gives `outputCount` 0 every tick, because a failure
    in the section wins over reaching the end (§5.2). The live example is §8's last row.
- Pod configuration (`Napole__*`: ES URL, lag, trail, and four of the report dimensions) is
  unchanged (2026-11-08 §5), except that **`Napole__Report__ReporterSubComponentName` is removed
  (decided)**. It moves from `ReportDimensions` and its startup validation to the payload. *My
  call:* if the variable is still set, it is ignored. It does not override the payload or act as a
  fallback.

## 4. The records relied on

All from `service.name == "orchestrator"`, all carrying `attributes.WorkflowId`,
`attributes.ExecutionId`, `attributes.StepId` and `attributes.EntryId` (one `EntryId` per step run).
The one exception is the root record of an entry step that failed or cancelled, which has no execution
(below).

| record | template | carries |
|---|---|---|
| **root** | `the entry step completed with {Result}` | one per run of a workflow entry step (`StepOutcomeHandler.cs:269`) |
| **advanced** | `OutcomeTemplates.Advanced` | `SuccessorCount` |
| **branch ends** | `OutcomeTemplates.BranchEnds` | `Result` |
| **advanced anyway** | `advancing {SuccessorCount} successor(s) on a {Result} step — their entry conditions accept it` | `Result` (Failed or Cancelled), same `EntryId` as its **advanced** record (`StepOutcomeHandler.cs:428`) |

**A step run's outcome** (one per `EntryId`):

| records for that `EntryId` | outcome |
|---|---|
| branch ends | its `Result` |
| advanced + advanced anyway | the warning's `Result` |
| advanced alone | Completed |

Verified on every step of the live workflow (§8). The kafka-importer's import record is **no longer
used**: the root record replaces it, for every entry processor.

**An entry step that fails or cancels has no execution.** The dispatch carries no execution id. If
the entry step fails or cancels, it reports `Guid.Empty`, and the log scope leaves empty ids out, so
that root record has no `ExecutionId` or `EntryId` and the query never sees it. Examples are the
importer failing to reach Kafka, or cancelling on an empty topic. So **input means runs that produced
an execution**, which is what the import record meant before. A section that starts at the entry
step never counts the entry step's own failures. A one-step section on the entry step reports
output equal to input. *My call:* that is accepted and documented. Counting them would need the
orchestrator to give those records a key, which is outside Napole.

The user's rule says the same thing from the other side **(decided)**: once there is an ExecutionId,
the execution is moving through the workflow, and it can fail, cancel or complete on the way to
`toStepId`. Checked in ES (all data to 2026-11-09):
- all 70,212 Completed root records carry an ExecutionId;
- none of the 9,056 Cancelled root records do, and neither does the 1 Failed one;
- the code is `ProcessDispatchHandler.cs:361`, where a failure outcome carries the dispatch's own,
  empty, execution id.

**Contract.** `Advanced` and `BranchEnds` are already constants in `Messaging.Contracts`. The root
and advanced-anyway templates are still literal strings in the orchestrator, and the second is
built by concatenation. *Builder's call, but required:* move both into `OutcomeTemplates`, used by
the orchestrator and by Napole, so a rewording cannot break Napole silently. Changing that library
means repacking it (see the repo's notes on `Messaging.Contracts` as a pinned package).

## 5. The tick

### 5.1 Window and selection

The window is unchanged: `to = floor(now − lag, windowMinutes)`, `from = to − windowMinutes`, trail
`[from − trail, to + trail)` (2026-11-08 §4.1, including the mid-slot cron guidance).

**Input selection changes.** An execution belongs to the tick when its **first step-run outcome at
`fromStepId`** (`fromT`) is in `[from, to)`. Today it is the import time. For a section starting at
the entry step the two are milliseconds apart.

### 5.2 The verdict, per execution (decided: per execution)

For each selected execution, over its records in the trail:

```
fromT     = earliest outcome at fromStepId
toT       = latest Completed outcome at toStepId, or none
section   = step runs with fromT ≤ time ≤ toT   (no toT: every step run from fromT on)
roots     = count(root records)
open      = roots + Σ SuccessorCount(advanced) − (count(advanced) + count(branch ends))
```

In this order:

1. `roots ≠ 1` → **left out** (two runs of one id in the trail, or the entry not in the trail).
   This replaces the old `imports ≠ 1` guard (2026-11-08 §4.2).
2. a Failed outcome in the section → **failed**, even with a branch still open. The first failure
   wins, even if a failure branch then completes. This is the decided order from 2026-11-08 §4.4,
   as `RoundTripRules.Decide` implements it today: a failed run that is still running a slow
   failure branch must not be lost as unfinished, since no later tick will report it.
3. `open > 0` → **unfinished**, left out. The whole execution must have finished, including steps
   after `toStepId`. A cancel with a branch still open is unfinished, as today, because that branch
   could still fail.
4. a Cancelled outcome in the section → **discarded**.
5. a Completed outcome at `toStepId` → **output**.
6. otherwise → **bypassed**: the run finished cleanly by a route that does not pass `toStepId`.
   **Left out** (*my call*). Counting it as anything would break the identity or say something
   false.

`inputCount` = failed + discarded + output. Left-out, unfinished and bypassed runs are in no
count. Napole still asserts the identity before sending (unchanged).

`fromT` is the *earliest* outcome and `toT` the *latest*, because a step after a split runs once
per branch. A run whose two branches both reach `toStepId` is one output (§5.4).

### 5.3 Known limit: the section is bounded by time, not by the graph

The ids do not chain: a hand-off's `NextEntryId` is never the receiving step run's `EntryId`
(checked on a live run, 2026-11-09), so Napole cannot tell which branch a step run belongs to.
Hence:

- A failure on a **sibling branch that is outside the section**, timed between `fromT` and `toT`,
  marks the run failed.
- With no `toT`, every failure after `fromT` counts, on any branch.

Exact sections need the graph (step → successors) from BaseApi's workflow definition. Out of scope
(§2); this design accepts the time bound.

### 5.4 Why per execution, not per branch end (decided)

When branches meet again at `toStepId`, one execution produces two Completed outcomes there (16
executions, 32 ends in §8). Per end would make the input depend on the branching: input is counted
at `fromStepId`, before the split, where there is one run. And a failed or cancelled branch never
reaches `toStepId`, so its end is elsewhere in the graph, where Napole cannot tell whether it
belongs to the section without the graph.

### 5.5 The query

One ES|QL statement per tick replaces statements A and B (*my call*):

```
FROM logs-generic.otel-default
| WHERE attributes.WorkflowId == ?workflow AND resource.attributes.service.name == "orchestrator"
  AND attributes.ExecutionId IS NOT NULL AND @timestamp >= ?trailFrom AND @timestamp < ?trailTo
| EVAL fmt = TO_STRING(`attributes.{OriginalFormat}`)
| WHERE fmt IN (?root, ?advanced, ?branchEnds, ?advancedAnyway)
| STATS … BY attributes.ExecutionId, attributes.EntryId, attributes.StepId      -- one row per step run
| EVAL outcome = …                                                             -- §4
| INLINE STATS fromT = MIN(…), toT = MAX(…) BY attributes.ExecutionId
| STATS roots, open, failed, cancelled, reached … BY attributes.ExecutionId
| WHERE fromT >= ?from AND fromT < ?to
```

The working version is `section_bounded.py` in the session scratchpad
(`C:\Users\katan\AppData\Local\Temp\claude\C--Users-katan-source-repos-SK-P11\b6d3f0bf-0f32-4bc5-885f-8c3d177d6c11\scratchpad\section_bounded.py`).
That script matches templates with `LIKE "advancing*"`; Napole passes the contract constants as
params instead, as it does today.

- The verdict can be computed in ES|QL or in C# from per-execution rows. *Builder's call*. Keep the
  rules a pure, unit-tested function either way, as `RoundTripRules` is today.
- **`INLINE STATS` ran on the dev cluster's ES 9.3.** *Builder's call:* check its support status
  for the target cluster. The fallback is two statements: first the executions with
  `fromT ∈ [from, to)`, then their step runs.
- **Rows.** The query scans every orchestrator record of the workflow in the trail (about 30 minutes)
  before reducing to one row per execution. The 10,000-row truncation check is unchanged, on the
  final rows. *Builder's call:* whether a busier workflow needs the two-statement form for speed.

## 6. Nothing to report

Unchanged: no counted execution → `CancelledException`, no send (2026-11-08 §6). *My call:* the
message names `fromStepId` and `toStepId` as well as the workflow, so a typo in an id shows up in
the logs.

## 7. Unchanged

The report field names and their values (2026-11-08 §6), except where `reporterSubComponentName` comes from (§3); failures (§7), layout and deployment (§8),
and the window, lag and trail (§4.1).

## 8. Evidence (ES, 2026-11-09)

The live workflow `8cfdbcdb…` has five path types, each about a fifth of runs: Failed at
`split-filefetcher`, at `split-archiveexpander`, or at `sk-normalizer-sample`, each then completing
at `export-outcome`; Cancelled at `sk-normalizer-sample`; Complete at `split-exporter`, two ends
per run.

**Five sections, window 06:20–06:30 UTC**, computed by the ES|QL statement and recounted
independently in Python from raw records; identical in every case:

| section | input | output | failed | discarded | left out | matches the path types |
|---|---|---|---|---|---|---|
| importer → split-exporter (whole run) | 80 | 16 | 48 | 16 | – | ✓ |
| sk-normalizer-sample → split-archivecollapser (end mid-graph) | 48 | 16 | 16 | 16 | – | ✓ |
| split-archiveexpander → split-filepersister | 64 | 16 | 32 | 16 | – | ✓ |
| importer → split-filefetcher (first hop) | 80 | 64 | 16 | 0 | – | ✓ |
| split-filefetcher → export-outcome (failure path) | 64 | 0 | 48 | 16 | 16 bypassed | ✓ |

- **The verdict order.** The proof script checks *unfinished* before *failed*, where §5.2 checks
  failed first. In this window no run was unfinished, so the two orders give the same counts, and
  the table is valid for §5.2. A fixture with a failure and an open branch (§9) covers the
  difference.
- **The upper bound matters.** Without `toT`, the first-hop section counted 48 failed, 32 of them
  failing after `split-filefetcher`. With it, 16, which is right.
- **The open rule with the root record** balances to exactly 0 for all **42,817** executions in
  ES, across every workflow and entry type (2026-10-21 to 2026-11-09).
- **No duplicated outcome record** among about 425,000, keyed on time, ExecutionId, StepId,
  EntryId and template.

Step ids for fixtures (workflow `8cfdbcdb…`): importer `95225f8c-56b2-494b-a59d-d9b34fbde441`,
filefetcher `1f0e6725-b48e-42c6-ba13-ca8d4cd150cd`, archiveexpander
`3825ced5-62b7-4eed-b7b8-9551f7e82752`, normalizer-sample `4e36b683-e52c-45d7-b219-5583a480385f`,
archivecollapser `b8b926fe-fcf8-42db-9690-b8228050f95c`, filepersister
`3f316aba-f13f-4401-88cb-11778192a414`, split-exporter `06f1c5fd-bdfc-43ae-93c9-5bde2995e167`,
export-outcome `9b4224a5-b9a0-4b9f-a35f-d48dda62b15b`.

## 9. Tests (builder's call on the shape)

- **Outcome per step run:** each of the three record combinations in §4.
- **Verdict:** each row of §5.2, including a failure in the section with a branch still open
  (failed), a split that meets again at `toStepId` (one output), a
  failure after `toT` (not counted), a failure before `fromT` (not counted), a bypassed run, and
  `roots = 2`.
- **The five sections of §8** as fixtures, with their counts.
- **Payload:** the five fields required, including an empty or whitespace `reporterSubComponentName` refused; `fromStepId == toStepId` accepted; the report carries the payload's `reporterSubComponentName`, and the pod no longer requires the variable.
- **Live:** redeploy beside the split chain with a whole-run section, and check one tick against an
  independent recount, as 2026-11-08 §9 did.

## 10. Rollout

The payload shape changes, so the `napole-config` schema row is frozen and needs a **new version**,
and the running `napole-splitchain` workflow must be stopped, its Napole assignment updated with
the two step ids and `reporterSubComponentName`, and started again. The manifest
(`k8s/46-processor-napole.yaml`) drops `Napole__Report__ReporterSubComponentName`. The live
assignment keeps the value the pod sends today, so the topic's existing reports and the new ones
match. Use the repo's existing order for a config change: new
schema, stop, PUT the assignment, new image and pod, PUT the processor row, start.

**The orchestrator is not redeployed with Napole** (*my call*). The two templates moved into
`OutcomeTemplates` (§4) must stay byte-identical, em dash included, and a test pins them. Napole can
then ship on the repacked package while the running orchestrator still writes the same text. The
orchestrator picks up the constants at its next release, and nothing changes in ES.

## 11. Rejected shapes

- **Counting per branch end** (§5.4).
- **Tracing lineage through `NextEntryId` → `EntryId`.** The ids do not chain (§5.3).
- **The import record as the input.** It works only for kafka-importer entries; the root record
  works for all.
- **Requiring `fromStepId` to be an entry step and `toStepId` a terminal one.** Not needed; the
  outcome records exist for every step.
