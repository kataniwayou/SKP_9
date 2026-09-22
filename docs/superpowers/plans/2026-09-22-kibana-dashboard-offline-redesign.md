# Kibana Dashboard — Offline / Org-Cluster Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the operator dashboard run on an Elasticsearch cluster this project does not own — no ingest pipeline, no enrich policy, no lookup index, no privilege beyond read — without losing a single thing the built dashboard does today.

**Architecture:** Two independent halves. **Half 2** makes every step log its own outcome, including terminal ones, which collapses the counted set to a single property test that can live in the dashboard's own KQL query. **Half 1** puts human-readable names back by aggregating on raw ids and mapping id to `{name}_{version}` in a data-view `static_lookup` field formatter, applied at render time. What remains in `elastic/` is one NDJSON export and a generator that writes the formatter block.

**Tech Stack:** C# / .NET 8 (`BaseProcessor.Core`, `BaseApi.Service`), Elasticsearch 8.15.5 read-only, Kibana 8.15.5 saved objects, Python 3 with `requests` (stdlib + `requests` only — **there is no pytest in this environment and this plan does not introduce one**), kubectl/kind, `playwright-skill` headless for the two render checks.

**Spec:** `docs/superpowers/specs/2026-09-22-kibana-operator-dashboard-design.md` — **read §13 first, then the sections it supersedes.** Every section reference below points into that file. §1–§12 describe what is built today; §13 is what this plan changes it into.

**Predecessor plan:** `docs/superpowers/plans/2026-09-22-kibana-operator-dashboard.md`. Its execution record holds the twelve-document classification fixture table that Task 3 re-uses.

---

## Global Constraints

- **The order of the halves is not free.** Half 2 (Tasks 1, 3) must land before the `elastic/` deletions of Task 6, because the ingest pipeline is currently the only written definition of the counting rule. Half 1 (Tasks 2, 4) can land in either order relative to Half 2.
- **Nothing is deleted from `elastic/` until its replacement is verified.** Every file there is live today; the dashboard in the cluster is driven by the pipeline and policy they define. Deleting them early breaks a working dashboard and leaves no way to rebuild it.
- **Task 1 is a framework edit.** `BaseProcessor.Core` is consumed by the processors **as an extracted package**, so a rebuild without a repack tests the old code and goes green while the change is absent. Repack before believing any test result.
- **A framework edit moves no processor `SourceHash`.** The fold is project-only, so registration rows stay valid and no re-registration is needed. **Executed 2026-09-22: this is ONE image, not five.** The changed branch is guarded by `_processor.EndsLineage`, and `BaseExporter` is the only class that sets it — `Processor.KafkaExporter` is the repo's only sink, and it serves both of the two missing steps. Every other processor image carries an older framework build with no behavioural difference on this path; they get the new binary at their next routine rebuild.
- **Repacking `BaseProcessor.Core` invalidates ten `packages.lock.json` files** with NU1403, "the package is different than the last restore". `dotnet restore --force-evaluate` refreshes them and the result is committed. The Dockerfiles do **not** copy processor lock files, so an image build restores unlocked and succeeds while a local build still fails — do not read a green `docker build` as evidence the lock files are fine.
- **Keep the orchestrator's terminal line.** It is deliberately redundant and that redundancy is the mitigation for the log-loss risk in §10. It stops being *counted*; it does not stop being *emitted*. (§13.3)
- **The counted set stays a property test, never a template list.** `attributes.Result` present AND emitter is not the orchestrator. A list would silently uncount the three rarely-fired failure templates — the exact defect §4 exists to prevent. (§13.4)
- **Every string field in the log index is mapped `keyword`** by the `all_strings_to_keywords` dynamic template. `match`/`match_phrase` silently return zero hits. Use `term`, `prefix`, `wildcard`. (§7.4)
- **Kibana saved-object ids are fixed on purpose** — `skp-logs`, `skp-outcomes-bins`, `skp-outcomes-pie`, `skp-outcome-records`, `skp-operator-outcomes`. Check 9 asserts on them and a generated UUID breaks every re-import.
- **Hand-written Lens state imports clean and renders nothing.** "It renders with data" is the only check that means anything. Publish through the Kibana API, then render headless and read the legend back.
- **Host access is 127.0.0.1 port-forwards on offset ports** — ES `localhost:19200`, BaseApi `localhost:18080`, Kibana `localhost:15601`. The forwards are supervised by `k8s/port-forward-realstack.ps1`; never judge reachability by netstat on a default port.
- **The Grafana forward (`localhost:13000`) and the endless feed are running unsupervised from the previous session.** Do not restart them unasked. A killed background task can leave an orphan runner, and `pkill` does not exist on this machine — verify the process tree before relaunching anything.

---

## File Structure

| file | responsibility |
|---|---|
| `src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs` | *modify* — the terminal branch gains an `OutcomeLogScope` line of its own (§13.3). The long comment explaining why there is no scope there is now wrong and must be rewritten, not deleted. |
| `src/BaseApi.Service/Features/Orchestration/OrchestrationService.cs` | *modify* — emit `{EntityId, EntityName}` per entity between validation and `SendAsync` (§13.6). |
| `elastic/kibana-export.ndjson` | *modify* — dashboard-level KQL query, three controls with `ignoreQuery`/`ignoreTimerange`, data view `fieldFormats`, panels re-pointed at raw id fields. Becomes the whole deliverable. |
| `elastic/generate-field-formatters.py` | **new** — reads id→name pairs out of ES, writes the `fieldFormats` block into the data view saved object. The only thing that replaces `sync-entity-names.py`. |
| `elastic/classification-fixture.json` | **new** — the twelve documents of `simulate-outcome-classification.json`, re-purposed as a KQL fixture rather than a pipeline `_simulate` body (§13.5). |
| `elastic/README.md` | *rewrite* — the install order it documents is the thing being removed. |
| `elastic/logs-custom-pipeline.json` | **delete** — Task 6, not before. |
| `elastic/enrich-policy.json` | **delete** — Task 6. |
| `elastic/entity-names-index.json` | **delete** — Task 6. |
| `elastic/simulate-outcome-classification.json` | **delete** — Task 6, once Task 3 has an equivalent. |
| `tools/sync-entity-names.py` | **delete** — Task 6. |
| `tools/verify-kibana-dashboard.py` | *modify* — checks 2 and 3 go, check 5 covers 10 of 10, three new checks, all name keys become `{name}_{version}` (§13.7). |
| `docs/testing/kibana-operator-dashboard.md` | *modify* — §4.4 tables, the zoom guidance, and two new caveats: GUID-only free-text search, and a version bump relabelling history. |

---

## Task 1: A terminal step reports its own outcome — DONE 2026-09-22

This is the whole of Half 2's code change, and it is what lets the counting rule become a single clause.

**Files:**
- Modify: `src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs:358-392`

**Interfaces:**
- Consumes: the ambient `ExecutionLogScope.BuildScope(d)` opened at `ProcessDispatchHandler.cs:56`, which already carries `ExecutionId`, `WorkflowId`, `StepId`, `ProcessorId` and `EntryId`.
- Produces: one new `Information` record per terminal step completion, carrying `attributes.Result = "Completed"` under `scope.name` `BaseProcessor.Core.Processing.ProcessDispatchHandler`, with `attributes.EntryId` set to the dispatch's own.

- [x] **Step 1: Write the failing test**

Assert against the live index, over one feed cycle, that `attributes.Result` exists on records covering **10** distinct `StepId`s where `resource.attributes.service.name != "orchestrator"`. Today this returns 8 — `export-outcome` and `split-exporter` are absent. That measured 8-of-10 is the failing state (§13.3).

Add it to `tools/verify-kibana-dashboard.py` as the new form of check 5's coverage assertion. Run it and watch it report 8.

- [x] **Step 2: Emit the line**

Inside `if (ran && _processor.EndsLineage)`, wrap the existing `SendAsync` in a scope and log:

```csharp
using (_logger.BeginScope(OutcomeLogScope.BuildScope(StepResult.Completed)))
{
    _logger.LogInformation("the terminal step completed — there is no output to hand on");
    await SendAsync(...);
}
```

Three things are load-bearing and each has a reason recorded in §13.3:

- **`Guid.Empty` stays in the `StepOutcome` message.** It is not cosmetic — the reclaim above has already deleted that key, and naming it sends `StepOutcomeHandler` to read a blob that is gone. Only the *log* changes.
- **The `EntryId` in the log comes from the ambient scope**, which already holds `d.EntryId`. Do not pass it explicitly and do not pass `Guid.Empty`; that is the distinction the message-level concern must not be allowed to leak into.
- **The orchestrator's `the terminal step completed with {Result}` line stays exactly as it is.** Two markers on two pods is the mitigation for log loss (§10). It stops being counted, not emitted.

- [x] **Step 3: Rewrite the comment that says this must not exist**

The block at `ProcessDispatchHandler.cs:380-387` currently reads *"NO OutcomeLogScope HERE, DELIBERATELY"* and explains at length why. That reasoning is now superseded and leaving it in place beside code that contradicts it is worse than having no comment. Replace it with why the scope **is** here: terminal-step success was the one outcome invisible on the processor side, which forced the counted set into two clauses and left one slice of check 5 unreachable; §13.3 of the spec is the argument. Keep the paragraph about `Guid.Empty` — it is still true and still the thing a reader will get wrong.

- [x] **Step 4: Repack, rebuild, redeploy**

The processors consume `BaseProcessor.Core` as an extracted package. **Repack it first** — a test run against a stale package goes green with the change absent. Then rebuild and `kind load` all five processor images and roll them.

A framework edit moves no `SourceHash`, so **no re-registration and no schema-row change is needed**. If a rollout times out with pods `Running`/`NotReady` and 0 restarts, that is an unregistered processor waiting by design, not a crash — check the registration before touching the code.

- [x] **Step 5: Verify**

Re-run Step 1's assertion. It must report **10** distinct `StepId`s. Then confirm no double count appeared: the `(StepId, ExecutionId, EntryId)` triple must still carry at most one counted record per triple, now across all ten steps rather than eight.

Also re-check §4.4's totals. The per-cycle total should stay **30** and the split **26:3:1** — the new processor-side line replaces the orchestrator's in the count, it does not add to it. If the total moves to 35, the old terminal clause is still active in the counting rule; that is Task 3's job and it is expected to be wrong until then. Record which it is rather than treating a changed total as a failure.

**Execution record.** Measured before: 10 distinct `StepId`s carry `attributes.Result`, 8 of them
with a processor-side witness; the two without were `eb707c5e…` (`export-outcome`, 57 records /
10m) and `9cae7b00…` (`split-exporter`, 38 / 10m), both kafka-exporter, both matching their §4.4
per-cycle rows over ~19 cycles. After the roll, both appear processor-side within one cycle.

Measured after, on a clean 2-minute window — **the single-clause rule reproduces §4.4 exactly**:

| | per cycle |
|---|---|
| total | **30.0** (spec: 30) |
| Completed : Failed : Cancelled | **26 : 3 : 1** (spec: 26:3:1) |
| kafka-exporter | **5.0**, now processor-emitted rather than orchestrator-emitted |
| file-fetcher / kafka-importer | 5.0 / 5.0 |
| sk-normalizer / archive-expander | 4.0 / 4.0 |
| outcome-recorder | 3.0 |
| archive-collapser / file-persister | 2.0 / 2.0 |

**Zero** duplicate `(StepId, ExecutionId, EntryId)` triples, and **zero** counted records without an
`EntryId` — so check 5's uncovered slice is closed and the check now reaches 10 of 10 steps, as
§13.3 predicted. Hermetic suite after the repack: 1374 total, 0 failed, 37 skipped, exit 0.

---

## Task 2: The BaseApi emits id→name pairs — DONE 2026-09-22

Half 1's only code change. Independent of Task 1.

**Files:**
- Modify: `src/BaseApi.Service/Features/Orchestration/OrchestrationService.cs:108-130`

**Interfaces:**
- Consumes: `WorkflowGraphSnapshot` — `Workflows`, `Steps` and `Processors`, each a `Dictionary<Guid, …ReadDto>` whose DTO carries `Name` and `Version`.
- Produces: one log record per entity per accepted start, carrying `attributes.EntityId` and `attributes.EntityName`, under service name **`baseapi`** (not `base-api`).

- [x] **Step 1: Write the failing test**

Query ES for records carrying `attributes.EntityName` from service `baseapi`. Today: zero. Add it to the verification tool as the source check for the formatter generator of Task 4.

- [x] **Step 2: Emit the pairs**

Between the liveness gate and `SendAsync` — after `var definition = ToDefinition(snapshot, workflowId);` is the natural place, where the snapshot is known valid and not yet disposed. One `LogInformation` per entity across all three dictionaries, with `EntityId` and `EntityName` as message-template parameters so they land in `attributes.*`.

`EntityName` is **`{name}_{version}`**, composed once, so that the formatter generator never has to know the composition rule (§13.2).

**Not the orchestrator's handler.** `WorkflowL1`/`StepL1` are ids-only — the names do not survive the projection, and the BaseApi is the last place they exist (§13.6).

- [x] **Step 3: Consider the volume**

`baseapi` already exports ~1,199 records / 2h, and its `/health/*` probe logs already dominate the index at ~58k/day. This adds roughly (1 workflow + N steps + M processors) records per start — on the validation chain, ~19 per start against a 30-second cron. That is real and it is small next to the probe logs, but it is worth one sentence in the operator notes rather than a surprise.

- [x] **Step 4: Verify**

Re-run Step 1. Confirm the pairs are present for all three entity kinds, that `EntityName` reads `{name}_{version}`, and that every `EntityId` in the index resolves against the BaseApi's own REST routes.

**Execution record, and it changed one thing the spec got wrong.**

§13.6 called these "one record per entity per accepted start" and the plan's Step 3 priced the
volume at ~19 records per start against a 30-second cron. **That arithmetic was wrong, because the
cron does not come through here.** `WorkflowFireJob` lives in the Orchestrator and fires against the
L1 projection, which is ids-only — `OrchestrationService.StartAsync` runs when a client POSTs a
start, and not again. A workflow started last week and running ever since has emitted its pairs
exactly once, at that moment.

So the volume worry evaporates, and **a retention dependency takes its place**, which is the more
serious of the two. A reader building the map must search back far enough to find the last start,
not the last few minutes; a workflow whose start has aged out of the index has no pairs at all.
Two consequences:

- **Task 4's generator must query over a wide window** — all time, not the dashboard's range.
- **Deploying this change is not enough to get labels.** Every workflow must be started once
  afterwards. Today only `simple-abc` has pairs, because it is the one started since the roll. The
  validation chain has been running since before it and has none. That is an operator step for the
  notes, not a code change.

`EntityKind` was added beyond what §13.6 specified. A reader cannot recover it: these records say
"this GUID is called that", and nothing in them says whether the GUID belongs in the Workflow control
or the Step control. Without it the generator would have to infer the kind from which field the id
later appears in, which is the join being avoided.

Verified: starting `simple-abc` emitted 5 pairs from service `baseapi` — 1 workflow, 3 steps,
1 processor — each rendering `{name}_{version}` (`simple-abc_1.0.0`, `simple-stepA_1.0.0`,
`sample-proc-v9_1.5.0`). Hermetic suite: 1374 total, 0 failed, 37 skipped, exit 0.

**Side effect, deliberate: check 9's precondition is now met.** Starting `simple-abc` to verify this
task also gave the counted set a second workflow — measured over 2 minutes, 60 records across 10
steps for the chain and 18 across 3 steps for `simple-abc`. Handover item 2 is closed as a
by-product. `simple-abc` can be stopped again through `POST /api/v1/orchestration/stop`.

---

## Task 3: The counting rule moves into the dashboard query

**Files:**
- Modify: `elastic/kibana-export.ndjson` — dashboard-level query
- Create: `elastic/classification-fixture.json`
- Modify: `tools/verify-kibana-dashboard.py`

**Interfaces:**
- Consumes: the ten-step outcome coverage Task 1 produces.
- Produces: a dashboard whose counted set is defined once, in its own KQL, with `skp.outcome_record` referenced nowhere.

- [ ] **Step 1: Port the fixture before deleting its home**

`elastic/simulate-outcome-classification.json` is twelve documents, one per template of §4, and **three of them are the rarely-fired failure paths that never appear in live traffic.** Once the pipeline goes, `_simulate` is not available to test them. Write `elastic/classification-fixture.json` as the same twelve documents plus their expected verdicts, and a check that bulk-indexes them into a scratch index, runs the §13.4 KQL against it, asserts the verdicts, and deletes the index.

Without this, those three failure paths return to being unverified — which is precisely the defect §4 was written to prevent.

- [ ] **Step 2: Set the dashboard query**

```
attributes.Result:* and not resource.attributes.service.name:"orchestrator"
```

Dashboard-level, once. The controls respect it (`ignoreQuery: false`) — **except** the entity-name controls of Task 4, which deliberately do not.

§6.6's objection to this is measured false: `attributes.{OriginalFormat}` escapes as `attributes.\{OriginalFormat\}` and §4.1 written directly as KQL returned 1,110 against the flag's 1,110. It is recorded here because the claim is stated confidently in the superseded section and will be re-derived otherwise.

- [ ] **Step 3: Verify**

Fixture check passes on all twelve. Then live: the dashboard total over N cycles equals `30 × N` and each processor matches its §4.4 row, with the pipeline flag no longer referenced anywhere in the export (`grep skp.outcome_record elastic/` returns nothing but the files Task 6 deletes).

---

## Task 4: Names by field formatter

**Files:**
- Create: `elastic/generate-field-formatters.py`
- Modify: `elastic/kibana-export.ndjson` — data view `fieldFormats`, controls, panel split fields

**Interfaces:**
- Consumes: the `{EntityId, EntityName}` records of Task 2, plus the processor pairing that already exists on every processor record (`resource.attributes.ProcessorId` + `resource.attributes.service.name`).
- Produces: a data view whose `attributes.WorkflowId`, `attributes.StepId` and `attributes.ProcessorId` fields render as `{name}_{version}`.

- [ ] **Step 1: Settle `unknownKeyValue` by experiment — before anything else**

An id absent from the map must render as **its GUID**, not blank. Blank is worse than no formatter: a newly published entity would silently disappear from the legend rather than showing an unreadable-but-present bar. This is untested (§13.2) and it decides whether the design is usable, so it comes first.

Map two ids, leave the rest unmapped, publish, render headless, read the legend. If no `unknownKeyValue` setting produces the GUID, stop and report — the rest of this task depends on the answer.

- [ ] **Step 2: Write the generator**

Reads the pairs out of ES (**not** from the BaseApi — §13.2 drops that dependency deliberately, because the API may not be reachable from wherever this is run), emits the `fieldFormats` block, and writes it into the data view object in `elastic/kibana-export.ndjson`. Its output is committed; it is a build step, not a runtime dependency.

- [ ] **Step 3: Re-point controls and panels at raw ids**

Three controls — Workflow / Step / Outcome — on `attributes.WorkflowId`, `attributes.StepId`, `attributes.Result`. No Processor control. Bins split on `attributes.ProcessorId`.

**The two entity controls need `ignoreQuery: true` and `ignoreTimerange: true`** so every published step appears whether or not it ran. Without them the Task 2 records that supply the options are filtered out by the Task 3 query, and vanish from the list once the orchestration-start line scrolls out of the time range (§13.2).

- [ ] **Step 4: Verify**

Render headless and read back. Both the options list and the Lens legend must show `{name}_{version}`; this was verified in principle on this exact Kibana version, so a failure here is an error in the export, not a limitation. Then: a step that has never run appears in the dropdown, and an unmapped id shows its GUID.

---

## Task 5: The verification tool matches §13.7

**Files:**
- Modify: `tools/verify-kibana-dashboard.py`

- [ ] **Step 1: Delete checks 2 and 3**

Both test enrichment that no longer exists. Deleting a check is the kind of change that hides a regression, so each deletion carries a one-line comment naming the §13 section that retired it.

- [ ] **Step 2: Strengthen check 5**

`(StepId, ExecutionId, EntryId)` across **10 of 10** steps. The uncovered-slice paragraph goes. In its place: a step that is both an entry step and a terminal step has `EntryId == Guid.Empty`, which `ExecutionLogScope` omits, so it is uncheckable — no workflow in the cluster has one, a one-step workflow would, and check 4's per-processor assertion is the guard (§13.3).

Keep the three-field key. The two-field version reported ~15 false duplicates per 10 minutes on a healthy run; the chain fans out and one step legitimately completes several times inside one `ExecutionId`.

- [ ] **Step 3: Re-key the expected tables**

`PER_CYCLE_BY_STEP`, `PER_CYCLE_BY_PROCESSOR` and `VALIDATION_WORKFLOW` all become `{name}_{version}`. Read the current versions off the live rows rather than assuming `_1.0.0`.

- [ ] **Step 4: Add the three new checks**

The fixture check (Task 3), the `unknownKeyValue` check (Task 4), and the never-run-step-in-dropdown check (Task 4).

- [ ] **Step 5: Verify**

Full run. Expect **11 of 12** — check 9 still fails for want of a second driven workflow, and that is a traffic gap, not a dashboard defect. Five of the six workflows have crons but are stopped; a workflow with neither a cron nor an explicit start logs nothing and looks broken, so start one explicitly if check 9 is to be closed.

---

## Task 6: Cut `elastic/` down — last, never earlier

**Files:**
- Delete: `elastic/logs-custom-pipeline.json`, `elastic/enrich-policy.json`, `elastic/entity-names-index.json`, `elastic/simulate-outcome-classification.json`, `tools/sync-entity-names.py`
- Rewrite: `elastic/README.md`
- Modify: `docs/testing/kibana-operator-dashboard.md`

- [ ] **Step 1: Confirm both replacements are live before deleting anything**

Two things must have moved or they are lost:

- the **classification rule**, which lives in `logs-custom-pipeline.json` until Task 3's query exists and is verified;
- the **twelve-document test**, which is `simulate-outcome-classification.json` until Task 3's fixture check passes.

If either is outstanding, stop. Deleting these files while the cluster's dashboard still runs on them breaks a working dashboard and leaves no way to rebuild it.

- [ ] **Step 2: Remove the live ES objects too**

`logs@custom`, the `skp-entity-lookup` enrich policy and the `skp-entity-names` index exist **only in cluster state** — a rebuild restores Kibana from kustomize but not these. Delete them in reverse install order (pipeline, then policy, then index); ES rejects a policy deletion while a pipeline still names it.

- [ ] **Step 3: Rewrite `elastic/README.md`**

The install order it documents — index, policy, execute, pipeline — is exactly what is being removed, and it is the file most likely to be read by someone rebuilding on the org cluster. It becomes: import the NDJSON, run the generator, nothing else.

- [ ] **Step 4: Update the operator notes**

`docs/testing/kibana-operator-dashboard.md` — the §4.4 tables and the zoom guidance, plus two new caveats that did not exist under the old design: free-text search now needs GUIDs, and a version bump relabels history (§13.2). Both are honest regressions and both belong where an operator will hit them.

- [ ] **Step 5: Verify**

Full verification run after the deletions, from a cold Kibana import, to prove the dashboard stands on the NDJSON and the generator alone.

---

## Decided: the chain diagram stays off the dashboard

**Decided 2026-09-22 — do not embed it, and do not add a `links` panel for it either.** The
diagram is orientation, and `docs/testing/kibana-operator-dashboard.md` is already where a
reader is sent for that. It costs nothing, it keeps one source of truth, and it leaves the
dashboard as the five things it was asked for.

The findings below are kept because re-establishing them costs a session, and because a later
reader asking "could we just embed it?" deserves the measured answer rather than the decision.

Established against the live Kibana 8.15.5: a `links` panel is available but renders links, not content; an Image panel is **probably** available (`image` is not an allowed saved-object type, but `POST /api/files/find` returns 200, so the Files plugin is present — confirm in the UI); there is **no iframe or raw-HTML panel**, and the Markdown panel sanitizes HTML, so the inline `<svg>` in `docs/diagrams/filefetcher-archiveexpander-chain.html` cannot render through it; and `file:///C:/...` will not load from a page served over http, so the local path is unusable as a link target or a panel source regardless of panel type.

The three options not taken, and what each would have cost: serving the HTML over http and adding
a `links` panel keeps the diagram interactive and single-sourced but needs somewhere to serve it
from, and nothing in `k8s/` does that today; rendering it to an image buys visual presence at the
cost of a second copy that drifts from the HTML; re-authoring as Vega makes it a true panel and is a
substantial rewrite of a hand-drawn schematic.

---

## Out of scope

- **Check 9's second workflow.** It is a traffic gap — five workflows are stopped — not a dashboard change. Starting one is a precondition for closing the check, not work this plan does.
- **Adopting Elasticsearch into `k8s/`.** Still the explicit non-goal of §2.
- **Everything in §12.** Failure-reason table, failure-ratio panel, heartbeat tile, duration percentiles, lineage funnel. Declined during the original design and not revisited here.
- **The org-cluster unknowns of §13.9.** Data-view edits **are** permitted (answered 2026-09-22), so
  Half 1 stands. Three remain — Kibana's presence and version, the Space, and the data stream's
  identity — and each can still invalidate part of this plan. They are answered by asking, not by
  building.
