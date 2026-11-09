# Napole reach counting — Design

**Date:** 2026-11-09 · **Status:** draft for review · **Branch:** `feature/ems-exporter`
**Revises:** [2026-11-09-napole-sections-design.md](2026-11-09-napole-sections-design.md) (implemented
and live), which revised [2026-11-08-napole-design.md](2026-11-08-napole-design.md). Those documents
stay the authority for everything this one does not change, named per section below.

The sections version decides one verdict per execution, waits for every branch to end, bounds the
section by time, and asserts output + failed + discarded = input. This revision replaces that with a
simpler rule: **trace each execution from `fromStepId`, and count the step outcomes where it ended:
at `toStepId` if it reached it, or where it failed or was cancelled on the way if it did not.** The
counters count step outcomes, not executions, with no deduplication.

Sections marked **(decided)** are the user's decisions from the 2026-11-09 conversation. *My call*
marks a default the builder may change without asking.

---

## 1. Why

The sections rule had an open limit (sections spec §5.3): when branch A reached `toStepId` and branch
B failed afterwards, the run read Complete; had B failed first, it read Failed. Which one Napole
reported depended on which branch finished first. The user resolved it by changing what is counted.
`toStepId` marks the end of the lineage being reported on. What matters is **whether each execution
reached it**, which tells Napole where to look for the outcome, and **the outcomes themselves**,
which fill the counters.

## 2. The rule (decided)

### 2.1 Who is traced

Every execution of `watchedWorkflowId` whose **first outcome at `fromStepId`** (`fromT`) falls in
the window `[from, to)` **(decided)**. This is unchanged from sections spec §5.1.

### 2.2 Where each traced execution's outcomes are read

Only step runs with a timestamp at or after `fromT` are considered (*my call*, as today: what
happened before the section started is not part of it).

| the execution… | the outcomes counted | counted into |
|---|---|---|
| **reached `toStepId`**: at least one step run of `toStepId` at or after `fromT` | **every** outcome at `toStepId` | Completed → `outputCount`, Failed → `failedCount`, Cancelled → `discardedCount` |
| **did not reach `toStepId`**, and has Failed or Cancelled step outcomes | **every** Failed and Cancelled outcome after `fromT` | Failed → `failedCount`, Cancelled → `discardedCount` |
| **did not reach `toStepId`**, and has no Failed or Cancelled outcome | none | not in the report this tick |

- **Reached → only `toStepId`'s outcomes count (decided).** Failures elsewhere in an execution that
  reached `toStepId`, on another branch or earlier on the same branch, are not counted. Whether it
  reached is what tells Napole where to find the reason.
- **Per step outcome, no deduplication (decided).** An execution whose two branches both reach
  `toStepId` adds **2**. An execution that fails on two branches without reaching it adds **2** to
  `failedCount`. The operator places `toStepId` and owns what that does to the counts **(decided)**.
- **No waiting (decided).** Napole decides at tick time from what is in ES. There is no "every branch
  ended" check. An execution that reached `toStepId` on one branch is counted even while another
  branch is still running, and what that branch does later is never counted: the execution belongs
  to this tick's window, and the next tick does not select it again.

### 2.3 The report

- **`inputCount`** = the traced executions with a **proven end** **(decided)**: they reached
  `toStepId`, or had a Failed or Cancelled outcome on the way. Executions still on their way, or that
  left by another route without failing, are not in it.
- **`outputCount`, `failedCount`, `discardedCount`** = step-outcome counts per §2.2.
- **The counters no longer sum to the input (decided).** Input counts executions, the counters count
  step outcomes. With two branches meeting at `toStepId`, output is twice the executions that reached
  it. The identity assertion in `ReportBuilder` goes. The 2026-11-08 "hermetic" rule
  (`output + failed + discarded = input`) is **replaced**.
- No proven end in the window → no report, a `CancelledException` naming the section (unchanged,
  sections spec §6).
- The report's fields and names are unchanged (2026-11-08 §6). All five dimensions now come from
  the payload (§2.5).
- **The published report contract changes meaning** (*my call*, following the decision above).
  `napole-report.json` describes `inputCount` as executions "whose round trip terminated" and says
  the counters sum to it. Its descriptions are rewritten to §2.2–2.3, and it is published as a new
  schema version, `napole-report` 2.0.0, with the processor row's `outputSchemaId` pointed at it. A
  schema a processor references is frozen, so it cannot be edited in place. The fields, types and
  `required` list do not change, so a consumer's parser keeps working. A consumer that computes
  `output / input`, or failures as `input − output`, will get different answers from the rollout on.
  Whoever reads `skp-napole-reports` should be told.

### 2.4 What goes away

| sections rule | now |
|---|---|
| open branches (`roots + Σ SuccessorCount − handled`), "wait until the run ended" | gone **(decided: no waiting)** |
| the time bound `[fromT, toT]` for failures | gone: reached → only `toStepId`'s outcomes count |
| verdict order Failed > Unfinished > Cancelled > Complete > Bypassed | gone: no single verdict per execution |
| `roots ≠ 1` → left out | kept only as **`roots > 1` → left out** (*my call*): two runs of one ExecutionId in the trail, a re-import, would mix two runs' outcomes. A root outside the trail (`roots = 0`) no longer matters, because nothing needs to know whether the run ended. |
| identity assertion | gone (§2.3) |
| warning when no traced execution reached `toStepId` | **kept** (*my call*): a typo in `toStepId` still turns every execution into "not reached", so the warning is still how the operator notices |
| left-out counts in the report log line | kept, as "not in report" (no proven end) and "re-imported" (`roots > 1`) |

### 2.5 The payload: all five report dimensions move in (decided)

The five report dimensions leave the pod's environment and join the step payload, **in this
order, after the four existing fields (decided)**:

```json
{
  "watchedWorkflowId": "8cfdbcdb-a7e0-4a7d-9b4d-e4120ccacf02",
  "fromStepId": "95225f8c-56b2-494b-a59d-d9b34fbde441",
  "toStepId": "06f1c5fd-bdfc-43ae-93c9-5bde2995e167",
  "windowMinutes": 10,
  "reporterComponentName": "myDepartment",
  "reporterSubComponentName": "myTeam",
  "reporterNetworkName": "myNetwork",
  "srcCode": "928",
  "sagCode": "LLL"
}
```

- **Nine fields, all required.** Each dimension is a string, `minLength: 1` in the schema, and a
  whitespace-only value is a `FailedException` at run time. That is the rule `reporterSubComponentName`
  already has, now applied to all five (*my call*). `srcCode` stays a string, as the report carries
  it.
- They are copied unchanged into the report's `commonDimentions`, as today.
- **The order** is the order of the schema's `properties` and `required`, of the `NapoleConfig`
  record's parameters, and of every example. JSON readers do not depend on it.
- **The pod's `Napole:Report:*` section goes** (decided): the `ReportDimensions` options class, its
  four startup validations, and the four `Napole__Report__*` variables in
  `k8s/46-processor-napole.yaml`. The pod keeps `ElasticBaseUrl`, `LagSeconds` and `TrailMinutes`. A
  leftover `Napole__Report__*` variable binds to nothing and is ignored.
- Each Napole step now carries its own full set of dimensions. Two sections can be told apart by any
  of them. Keeping them right is the operator's responsibility, as with the ids.
- **Schema:** `napole-config` 3.0.0, with the nine fields, `additionalProperties: false`, title
  "Napole step payload v3".

## 3. Unchanged

- The payload's first four fields and their validation: sections spec §3. The rest of the payload
  changes (§2.5).
- The records and how a step run's outcome is derived: sections spec §4.
- The window, lag, trail and mid-slot cron: 2026-11-08 §4.1.
- Report fields, failures and deployment: 2026-11-08 §6–8.
- The operator owns the ids, the sub-component name, and matching the cron to the window.

## 4. The query

It is still one ES|QL statement over the same records: one row per step run, then one row per
execution. The per-execution columns become:

| column | meaning |
|---|---|
| `roots` | root records, for the `roots > 1` guard |
| `reached` | step runs of `toStepId` at or after `fromT` |
| `endCompleted`, `endFailed`, `endCancelled` | `toStepId` outcomes at or after `fromT`, by outcome |
| `wayFailed`, `wayCancelled` | Failed and Cancelled outcomes at any step at or after `fromT` |

`openBranches`, `toT` and `inSection` are dropped. The C# side then applies §2.2: if `reached > 0`,
count the `end*` columns; else if `wayFailed + wayCancelled > 0`, count those; else skip. The rule is
pure and unit-tested, as `RoundTripRules` is today. *Builder's call:* the column names, and whether
`RoundTrip` becomes a per-execution "contribution" record (`Input`, `Output`, `Failed`, `Discarded`)
that `ReportBuilder` sums.

## 5. Evidence (ES, 2026-11-09)

The rule computed in Python from raw orchestrator records, window 07:50–08:00 UTC on workflow
`8cfdbcdb…`, the same window as the first live sections tick:

| section | input | output | failed | discarded | not in report |
|---|---|---|---|---|---|
| importer → split-exporter (whole run) | 80 | **32** | 48 | 16 | 0 |
| importer → split-filefetcher (first hop) | 80 | 64 | 16 | 0 | 0 |
| normalizer-sample → archivecollapser | 48 | **32** | 16 | 16 | 0 |
| archiveexpander → filepersister | 64 | **32** | 32 | 16 | 0 |
| filefetcher → export-outcome (failure path) | 64 | **48** | 0 | 16 | 16 |

- **Output doubles where two branches reach `toStepId`:** 16 good files, 32 arrivals at
  split-exporter, collapser and persister.
- **First hop:** every execution reached split-filefetcher, so its outcome there decides. 16 Failed
  at the fetcher, 64 Completed.
- **Failure path:** the 48 failed runs reach `export-outcome` and complete there, so they are
  **output**, because only `toStepId`'s outcome counts once it is reached. The 16 cancelled runs never
  reach it and are discarded. The 16 good runs never reach it and never fail, so they are not in the
  report. Choosing this end is the operator's responsibility.
- Proof script: `reach.py` in the session scratchpad
  (`C:\Users\katan\AppData\Local\Temp\claude\C--Users-katan-source-repos-SK-P11\b6d3f0bf-0f32-4bc5-885f-8c3d177d6c11\scratchpad\reach.py`).

## 6. Tests (builder's call on the shape)

- **The rule, pure:**
  - reached with 2 Completed → output 2;
  - reached with 1 Completed and 1 Failed at `toStepId` → output 1, failed 1;
  - reached, plus a Failed elsewhere → that failure not counted;
  - not reached with 2 Failed → failed 2;
  - not reached with 1 Cancelled → discarded 1;
  - not reached and nothing failed → not in input;
  - `roots = 2` → left out;
  - `roots = 0` and reached → counted.
- **Report:** counters may exceed input; no identity assertion; nothing with a proven end → no report.
- **Source:** the new columns read by name; the params unchanged.
- **Payload:**
  - the nine fields, all required;
  - each dimension refused when empty in the schema, and when whitespace at run time;
  - each dimension copied into the report;
  - the pod starts with no `Napole:Report:*` settings.
- **Live:** the whole-run section on the next tick, checked against `reach.py` for the same window.

## 7. Rollout

The processor code and the payload both change, so this follows the repo's order for a config
change (sections spec §10):
1. POST `napole-config` 3.0.0 (§2.5), and the rewritten `napole-report.json` as `napole-report`
   2.0.0 (§2.3).
2. Stop `napole-splitchain`.
3. PUT the Napole assignment (`dc5ca477`) with the nine-field payload. It keeps the current
   section and the values the pod sends today: `myDepartment`, `myTeam`, `myNetwork`, `928`, `LLL`.
4. Build the image, apply `k8s/46-processor-napole.yaml` alone (the `Napole__Report__*` variables
   removed), and restart the pod. Read the new source hash from its log.
5. PUT the processor row (`d336a2e3`, version 3.0.0, *my call*: the payload breaks) with the new
   hash, `configSchemaId` 3.0.0 and `outputSchemaId` 2.0.0.
6. Start the workflow.

The kafka-exporter step after Napole has no input schema of its own to change; the builder confirms
that from its processor row.

## 8. Rejected shapes

- **One count per execution at `toStepId`** (deduplicated): the user wants exactly the step outcomes.
- **Waiting for every branch to end**: the user wants no waiting.
- **The time-bounded section of the sections design**: replaced by "reached → `toStepId`'s outcomes".
