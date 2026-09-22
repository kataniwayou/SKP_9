# Kibana Operator Dashboard — Generic Workflow Step Outcomes

**Date:** 2026-09-22
**Status:** Built and deployed (§1-§12). **§13 amends it** - the Elasticsearch half is
replaced for an org-owned cluster; agreed and experimentally verified, not yet implemented.

## 1. Goal

One Kibana dashboard an operator opens to answer, for any workflow: *is it running, and if something is wrong, which step is it?*

It shows step outcomes binned over time — one coloured bin per participating processor — beside a pie of the outcome distribution, and lets the operator click through to the logs behind any slice.

The dashboard is **generic**. It is not built for `filefetcher-archiveexpander-chain`; that workflow is only the one it is validated against. A workflow published next month appears in its dropdown with no dashboard change.

## 2. Scope

**In:** a Kibana 8.15.5 deployment; an ingest-time enrichment pipeline that resolves entity GUIDs to names and marks outcome records; a lookup index and enrich policy fed from the BaseApi REST routes by a new `tools/` script (§11); one data view; one dashboard with four controls, a bins chart, a pie, and a drill-down to a saved search.

**Out:** every idea raised during design and then withdrawn — failure-reason table, failure-ratio panel, heartbeat tile, duration percentiles, lineage funnel. None of them is in this dashboard. They are recorded in §12 only so a later reader knows they were considered and declined, not forgotten.

**Out:** alerting, Watcher, and any Kibana rule. This is a dashboard.

**Out:** a manifest for Elasticsearch. ES 8.15.5 runs in the cluster today with **no manifest in `k8s/`** — it was applied out of band. This design adds Kibana beside it and deliberately does not adopt ES; doing so is a separate decision about what `k8s/` is allowed to own.

**Later:** emitting names alongside ids from `BaseProcessor.Core`, which would retire the enrich policy entirely (§6.4).

## 3. Starting position, measured

Every number below was measured against the live index over 45 cycles of `tools/simulate-endless-feed.py` on 2026-09-22, not inferred.

### 3.1 What exists

- Elasticsearch **8.15.5**, `basic` license, active. Data stream `logs-generic.otel-default`, 2 backing indices, ~24M documents.
- The write index carries `index.default_pipeline = logs@default-pipeline` — the managed pipeline from the stock `logs` index template.
- That pipeline's last processor is `{"pipeline": {"name": "logs@custom", "ignore_missing_pipeline": true}}`. **`logs@custom` is not defined** (404). It is the supported extension point and it is unclaimed.
- No enrich policies exist (`GET _enrich/policy` → `{"policies": []}`).
- Grafana 12.3.9 is deployed with three dashboards. It reads Prometheus. It is not a substitute for this and is not touched.

### 3.2 What does not exist

- **Kibana.** No pod, no service, no manifest.
- **Any human-readable name in the log index.** There is no `WorkflowName`, `StepName` or processor-name attribute. `resource.attributes.service.name` carries a processor's service name (`file-fetcher`), and that is the only readable identifier anywhere in a log record.

### 3.3 The field set on an outcome record

Confirmed present on every record this dashboard counts:

```json
"attributes": {
  "Result": "Completed", "ElapsedMs": 16,
  "WorkflowId": "1a56b3ca-…", "StepId": "798b9dc8-…", "ProcessorId": "c046fb57-…",
  "CorrelationId": "00796c22…", "ExecutionId": "d16aea15-…", "EntryId": "154f4f9c-…"
},
"resource": { "attributes": { "service.name": "file-persister", "service.instance.id": "…" } }
```

### 3.4 `attributes.Result` holds exactly three values

```csharp
public enum StepResult { Completed = 1, Failed = 2, Cancelled = 3 }
```

Guaranteed rather than conventional: `OutcomeLogScope.BuildScope` renders `result.ToString()`, never a hand-typed string, precisely so the field cannot acquire a second vocabulary. The enum's history includes a `0` (`PreviousProcessing`) for rows written before both step validators rejected it; it never reaches this field.

## 4. The atom: what one "step outcome" is

**This is the load-bearing decision and the obvious answer is wrong.**

`attributes.Result` is carried by **nine** message templates, by design — `OutcomeLogScope`'s own documentation says the field is meant to span a processor's Warning line and the orchestrator's completion line so that `attributes.Result: "Failed"` finds both without a hand-join. The full set, read from every `OutcomeLogScope.BuildScope` call site in `src/`:

| template | `Result` | emitter scope |
|---|---|---|
| `branch completed in {ElapsedMs}ms` | Completed | `…Processing.ProcessedDataHandler` |
| `output failed its schema {OutputSchemaId} — reported failed: {SchemaErrors}` | Failed | `…Processing.ProcessedDataHandler` |
| `input failed its schema {InputSchemaId} — reported failed: {SchemaErrors}` | Failed | `…Processing.ProcessDispatchHandler` |
| `the author reported the step failed: {Reason}` | Failed | `…Processing.ProcessDispatchHandler` |
| `the author cancelled the branch: {Reason}` | Cancelled | `…Processing.ProcessDispatchHandler` |
| `the transform faulted — reporting the step failed` | Failed | `…Processing.ProcessDispatchHandler` |
| `the terminal step completed with {Result} — no successor accepts it, the run ends here` | Completed, Cancelled | `Orchestrator.Messaging.StepOutcomeHandler` |
| `the entry step completed with {Result}` | Completed | `Orchestrator.Messaging.StepOutcomeHandler` |
| `advancing {SuccessorCount} successor(s) on a {Result} step — their entry conditions accept it` | Failed | `Orchestrator.Messaging.StepOutcomeHandler` |

**Only six of the nine fired during the measured window.** The three that did not are the rarer processor-side failures — an input-schema rejection, an output-schema rejection, and an unhandled transform fault. An earlier draft of this section enumerated the six observed templates and called that the complete set; defining the counted set that way would have made exactly those three failures invisible, which are the ones an operator most needs to see. The set is therefore defined **structurally**, not by enumeration.

Spanning nine templates is right for **searching** and fatal for **counting**: a lineage is tallied two or three times. So the dashboard counts a defined subset.

### 4.1 The subset

> **Superseded by §13** — the two-clause rule collapses to one.

A record is counted if **either**:

- its `scope.name` starts with **`BaseProcessor.Core.Processing.`** and it carries `attributes.Result` — any template, any `Result`; **or**
- its `scope.name` is **`Orchestrator.Messaging.StepOutcomeHandler`**, its template is the **terminal-step** one, *and* `Result` is `Completed`.

The first clause is a prefix test rather than a template list precisely so a **new** framework failure path is counted the day it ships. Every `OutcomeLogScope` call site in `src/` lives in `BaseProcessor.Core.Processing`; no processor emits the scope itself, so the framework owns the vocabulary and the prefix is a complete description of the processor side. Verified against the index: `scope.name` partitions the Result-bearing records cleanly into `ProcessedDataHandler`, `ProcessDispatchHandler` and `StepOutcomeHandler`, with no service emitting under more than its own.

The second clause must still name a template, because all three orchestrator templates share one scope and two of them are duplicates. That list is short and stable — one file, `StepOutcomeHandler`.

**Excluded:** `the entry step completed with {Result}` and `advancing … on a {Result} step`. Both restate an outcome the processor side already emitted for the same step and lineage.

**Also excluded: terminal-step records whose `Result` is not `Completed`.** This qualifier is not tidiness, it is a correctness fix found during spec review — see §4.2.

### 4.2 Why the terminal-step template is in, and why only its Completed half

> **Superseded by §13** — the terminal template is no longer counted at all.

A step that hands on no output never emits `branch completed`. Measured: **8 of the chain's 10 steps** appear in the processor-emitted set; the two missing are both `kafka-exporter` steps, and `kafka-exporter` contributes **zero** processor-emitted records.

The orchestrator's terminal-step record recovers them. But breaking that template down by result and processor shows it carries two different things:

```
Result=Completed  230   ProcessorId=157a0f40-…   ← kafka-exporter
Result=Cancelled   46   ProcessorId=1673b377-…   ← sk-normalizer
```

The Completed half is **new information**: the exporter's outcome exists nowhere else. The Cancelled half is a **restatement**: `1673b377-…` is sk-normalizer, which already emitted `the author cancelled the branch: {Reason}` for the very same step and lineage. Counting the whole template double-counts every cancellation — 46 of them in the measured window.

The generic rule behind the qualifier: **`Failed` and `Cancelled` are always emitted by the processor that produced them** (`the author reported…`, `the author cancelled…`), so the orchestrator's copy is never the only witness. `Completed` is the one outcome a processor may not emit, because `branch completed` needs output to hand on and a terminal step produces none. So the terminal template is needed for `Completed` alone.

Measured, no step is witnessed twice under this rule: the 8 `StepId`s in the processor-emitted set and the 2 in the terminal-Completed set do not overlap. §9 check 5 is the regression test for that, and it is the check that caught this defect when it was deliberately reinstated during implementation. **Note that "witnessed twice" is per `(StepId, ExecutionId, EntryId)`, not per `(StepId, ExecutionId)`** — the same fan-out that gives file-persister two outcomes per cycle gives it two records under one `ExecutionId`, legitimately. See §9 check 5.

### 4.3 Consequence: the split field is `ProcessorId`, not `service.name`

> **Superseded by §13** — the first of its two arguments no longer applies.

Two reasons, both measured:

1. A terminal step's outcome is attributed by `ProcessorId` and would otherwise land under `orchestrator` (§4.2).
2. `service.name` merges steps. `sk-normalizer` is **two** steps in this workflow — the Acme branch and the AlphaBeta branch — and collapses to one series under `service.name`. Measured: 8 distinct `StepId`s across 7 distinct `service.name` values.

The operator selects processors; the chart splits by processor. Where one processor serves several steps, the Step control (§7) separates them.

### 4.4 The measured healthy shape, for the operator notes

Per cycle of five files, the counted set yields **30** outcomes — 26 Completed, 3 Failed, 1 Cancelled:

| processor | per cycle | breakdown |
|---|---|---|
| kafka-importer | 5 | 5 Completed |
| file-fetcher | 5 | 4 Completed, 1 Failed |
| archive-expander | 4 | 3 Completed, 1 Failed |
| sk-normalizer | 4 | 2 Completed, 1 Failed, 1 Cancelled |
| outcome-recorder | 3 | 3 Completed |
| archive-collapser | 2 | 2 Completed — runs once per normalizer branch |
| file-persister | 2 | 2 Completed |
| kafka-exporter | 5 | terminal-step Completed only: 2 documents + 3 failure exports |

**Bins are not expected to be equal.** Volume falls at a step that filters and rises at one that fans out. The dashboard presents the distribution over time; the operator decides what is correct for the workflow in front of them. Nothing in the dashboard encodes an expected profile.

## 5. Architecture

```
BaseApi REST  /api/v1/{workflows,steps,processors}
        │  tools/sync-entity-names.py   (on demand, and after any publish)
        ▼
  skp-entity-names            ── enrich policy: skp-entity-lookup ──┐
    {entity_id, entity_name, entity_kind}                            │
                                                                     ▼
processors ──OTLP──► otel-collector ──► logs@default-pipeline ──► logs@custom
                                                                     │
                                          enrich WorkflowId/StepId/ProcessorId → names
                                          stamp skp.outcome_record on the 4 templates
                                                                     ▼
                                                    logs-generic.otel-default
                                                                     ▲
                                                      Kibana 8.15.5 ─┘
                                                      data view → controls, bins, pie, Discover
```

## 6. Enrichment

### 6.1 Why it is in Elasticsearch and not in Kibana

> **Superseded by §13** — the field-formatter option dismissed here is the chosen design.

Kibana 8.15 cannot join. The alternatives were examined and rejected:

- **Data view static-lookup field formatter** — display only. It changes how a value renders; it does not create a field the Controls panel or an aggregation can use. Hand-maintained per field.
- **Runtime field with a painless GUID→name map** — works in aggregations and controls, but the map is a script edited by hand in the data view. Not generic; every new workflow is a script edit.
- **ES|QL `LOOKUP JOIN`** — not available in 8.15.

The **enrich processor** is a real server-side join, available on this cluster's `basic` license, and it produces ordinary indexed fields that every part of Kibana can use.

### 6.2 Proven, not assumed

The full path was executed against this cluster on 2026-09-22 before this design was written:

```
PUT  skp-entity-names (bulk, 2 rows)          → errors: false
PUT  _enrich/policy/skp-entity-lookup         → {"acknowledged": true}
POST _enrich/policy/skp-entity-lookup/_execute→ {"status": {"phase": "COMPLETE"}}
POST _ingest/pipeline/_simulate               →
     WorkflowId 1a56b3ca-… → "filefetcher-archiveexpander-chain"
     StepId     ab9d8741-… → "split-importer"
     unknown GUID          → document passes through unchanged
```

An unmatched id leaves the document intact rather than failing it — verified with the second simulate doc. All four artifacts were deleted afterwards; the cluster carries nothing from the proof.

### 6.3 The two honest limits

> **Superseded by §13** — both limits are retired; two different ones replace them.

**Enrichment applies only to newly indexed documents.** Everything already in the index keeps its GUIDs, and no reindex is planned. The dashboard is useful from the day the pipeline is installed, forward only. An operator looking at a range that predates installation sees GUIDs in the legend.

**Enrich reads a point-in-time snapshot of the lookup index.** Adding a row is not enough — the policy must be re-executed, which rebuilds the internal `.enrich-*` index. A workflow published after the last sync shows GUIDs until `tools/sync-entity-names.py` runs. This is why the sync script re-executes the policy as its final step rather than leaving it to the operator.

### 6.4 What would retire this

Emitting `WorkflowName`, `StepName` and `ProcessorName` as log attributes alongside the ids, in `BaseProcessor.Core` and the orchestrator's `StepOutcomeHandler`. Then there is no lookup index, no policy, no sync script and no staleness window. It is a code change across two projects and a redeploy of every processor, which is why it is not in this slice — but it is the better end state, and the enrich fields are named `skp.*_name` so that a later switch is a data-view change rather than a dashboard rewrite.

### 6.5 `logs@custom`

> **Superseded by §13** — there is no ingest pipeline.

Created, not edited: nothing managed is modified, and an Elasticsearch upgrade that replaces `logs@default-pipeline` keeps calling `logs@custom` because the call is part of the stock pipeline. Processors, in order:

1. `enrich` `attributes.WorkflowId` → `skp.workflow_name`, `ignore_missing: true`
2. `enrich` `attributes.StepId` → `skp.step_name`, `ignore_missing: true`
3. `enrich` `attributes.ProcessorId` → `skp.processor_name`, `ignore_missing: true`
4. `set` `skp.outcome_record: true`, conditioned per §4.1 — `scope.name` prefixed `BaseProcessor.Core.Processing.` with `attributes.Result` present, **or** `StepOutcomeHandler` + the terminal-step template + `Result == "Completed"`. The condition is a single painless `if`. Two things in it are load-bearing: the processor half must be a **prefix test, not a template list**, or the three rarely-fired failure templates of §4 are silently uncounted; and the terminal half must test `Result`, or every cancellation is double-counted (§4.2).
5. `remove` the intermediate enrich target objects

`on_failure` sets `skp.enrich_error` and lets the document through. **A logging pipeline must never drop a log because a lookup missed**; a silently discarded error record is worse than an unresolved GUID.

### 6.6 `skp.outcome_record`

> **Superseded by §13** — there is no flag, and the KQL-quoting claim here is false.

The flag exists so the dashboard's filter is `skp.outcome_record: true` rather than a template match. Two reasons:

- `attributes.{OriginalFormat}` does not quote reliably in KQL. The braces are a field-name character, and every dashboard filter, control and saved search would have to be written as raw Query DSL to avoid them.
- The definition of "an outcome record" then lives in **one** place — the pipeline — instead of being restated in four Kibana objects that can drift apart.

## 7. The dashboard

### 7.1 Controls

> **Superseded by §13** — three controls, aggregating on ids with a render-time formatter.

A Kibana Controls panel, all four options-list, all reading enriched name fields:

| control | field | selection |
|---|---|---|
| Workflow | `skp.workflow_name` | single |
| Processor | `skp.processor_name` | **multi** |
| Step | `skp.step_name` | multi |
| Outcome | `attributes.Result` | multi |

Chained so that Processor and Step offer only values present under the selected Workflow. The Step control is not redundant with Processor: §4.3 shows one processor serving two steps in the validation workflow.

### 7.2 Bins — step outcomes over time

Lens vertical stacked bar.

- Horizontal: date histogram on `@timestamp`, auto interval.
- Vertical: count of records.
- Break down by: `skp.processor_name`, one colour per value, palette fixed so a processor keeps its colour between visits.
- Filter: `skp.outcome_record: true` plus the control selections.

Every participating processor has a bin, including terminal-step-only ones such as `kafka-exporter` (§4.2). The operator selects which are relevant.

### 7.3 Pie — outcome distribution

Lens pie, terms on `attributes.Result`, same filters. Exactly three slices (§3.4) with fixed colours: Completed, Failed, Cancelled. Cancelled is coloured distinctly from Failed — a policy rejection and a defect send an operator to different places.

### 7.4 Drill-down

Slice click filters the dashboard in place, which is Lens default behaviour. In addition, a dashboard drilldown opens a saved Discover search carrying the active filters and time range.

Saved search columns: `@timestamp`, `skp.processor_name`, `skp.step_name`, `attributes.Result`, `attributes.Reason`, `attributes.ExecutionId`, `body.text`.

**A note for whoever uses Discover here.** Every string in this index is mapped `keyword` by the `all_strings_to_keywords` dynamic template. `match` and `match_phrase` need the *entire* field value and silently return zero hits otherwise. Free-text hunting needs `wildcard`, and structured filtering on `attributes.*` should be preferred over text matching on `body.text`.

## 8. Deliverables

| # | artifact | notes |
|---|---|---|
| 1 | `k8s/24-kibana.yaml` | Kibana 8.15.5, service, `ELASTICSEARCH_HOSTS`, resources, probes |
| 2 | `k8s/kustomization.yaml` | add the new manifest |
| 3 | `tools/sync-entity-names.py` | BaseApi REST → `skp-entity-names`, then re-execute the policy (§11) |
| 4 | `kibana/enrich-policy.json` | `skp-entity-lookup`, match on `entity_id` |
| 5 | `kibana/logs-custom-pipeline.json` | the `logs@custom` body of §6.5 |
| 6 | `kibana/kibana-export.ndjson` | data view, 2 Lens panels, saved search, dashboard |
| 7 | `docs/testing/kibana-operator-dashboard.md` | operator notes, including §4.4 and the keyword caveat |

Kibana saved objects are exported as NDJSON and imported by hand, matching how the Grafana dashboards are handled in this repo — hand-edited JSON, hand-imported, no provisioning ConfigMap.

## 9. Verification

> **Superseded by §13** — two checks deleted, one strengthened, three added.

Against the running simulator, which produces a known outcome mix every 30 seconds:

1. **Kibana reaches ES** — status green, data view resolves, document count non-zero.
2. **Enrichment lands** — a document indexed after installation carries `skp.workflow_name`, `skp.step_name`, `skp.processor_name` and `skp.outcome_record`.
3. **Unmatched ids survive** — index a record with a GUID absent from the lookup; the document is present, `skp.*_name` absent, no `skp.enrich_error` beyond the expected.
4. **No double counting, by total and per processor** — records where `skp.outcome_record: true`, over N cycles, equals `30 × N`, **and each processor matches its own §4.4 row**. The per-processor half is not redundant: it is what guards the terminal-`Completed` slice that check 5 cannot reach, because a terminal outcome counted twice reads as kafka-exporter at ~10 per cycle against its expected 5 while the grand total can still look plausible.
5. **No double counting, by witness** — no `(StepId, ExecutionId, **EntryId**)` triple carries more than one counted record. This is the structural version of check 4: it fails even when two errors cancel out in the total, and it is the check that caught the terminal-Cancelled defect of §4.2 when that defect was deliberately reinstated during implementation.
   **The key is three fields, and the two-field version in the first draft of this spec was wrong.** This chain fans out, so one step legitimately completes several times inside one execution — file-persister twice per cycle, archive-collapser once per normalizer branch — all sharing a single `ExecutionId`. Measured on a healthy run, the two-field key reported ~15 false duplicates per 10 minutes. `EntryId` is what separates the branches.
   **One slice is not covered: terminal-step `Completed` records, i.e. kafka-exporter alone.** Measured, those carry no `EntryId`, so two real branch terminations cannot be told from one outcome logged twice. Terminal-`Cancelled` records *do* carry one and are checked normally. `attributes.role` does not close the gap — `orchestrator-result` is a shared competing-consumer queue and deliberately not leader-gated, so `role` only records which replica took that branch, and filtering to `role=leader` drops real outcomes (measured: leader covered 12 of 27 distinct pairs). The uncovered slice is guarded numerically by check 4's per-processor assertion instead.
6. **Every processor has a bin** — the bins chart shows 8 series including `kafka-exporter`, with a non-zero count.
7. **Pie matches** — the three slices sum to the bins total, in the ratio 26:3:1 per cycle (Completed:Failed:Cancelled).
8. **Drill-down carries filters** — clicking Failed opens Discover pre-filtered, and the rows name the four expected reasons.
9. **Genuinely generic** — select a second workflow (`simple-abc` or `v8-fanout-proof`) in the Workflow control and confirm the whole dashboard repopulates with no edits.

Check 5 is the one that guards the design's central risk. Check 9 is the one that would catch it having been built for one workflow.

## 10. Risks

| risk | consequence | mitigation |
|---|---|---|
| Enrich policy goes stale after a publish | new workflow shows GUIDs | sync script re-executes the policy as its last step; §9 check 9 exercises it |
| Ingest pipeline error drops documents | silent log loss | `on_failure` passes the document through with `skp.enrich_error`; never a drop |
| A future template gains `attributes.Result` | miscounting | a processor-side one is picked up automatically by the scope prefix (§4.1); an orchestrator-side one is not, and `StepOutcomeHandler` is the one file to re-read when the orchestrator changes |
| A rare failure path never fires while the dashboard is being built | a template list looks complete when it is not | the set is a scope prefix, not a list — this is exactly the defect §4 records |
| A terminal step is added that *does* emit output | it would be witnessed twice | check 5 fails on the `(StepId, ExecutionId)` pair rather than silently inflating a bin |
| Kibana version drifts from ES | Kibana refuses to start | pin 8.15.5 in the manifest; upgrade both together |
| Historical data has no enriched fields | dashboard looks empty for old ranges | stated in §6.3 and in the operator notes; default the dashboard's time range to a recent window |
| A log record is lost in transit | a bin under-reports, and a missing bar reads as a failed step | **unfixable here, and it must be in the operator notes.** The authoritative outcome is the `StepOutcome` on `orchestrator-result`, which never reaches Elasticsearch; this dashboard reads the *log* of that outcome, exported best-effort. The collector's logs pipeline has no processors and drops nothing deliberately, but before retry and a sending queue were added on 2026-09-11 a failed export silently lost 1–3 records every ~15s, surfacing as whole hops missing from a correlation trace. Past 5 retries or a full 5000-item queue it still can. Treat the counts as an observability signal, not an accounting ledger |
| ES is unmanaged in `k8s/` | Kibana is manifested against a dependency that is not | called out in §2 as an explicit non-goal, not an oversight |

## 11. Decisions taken, with the alternative recorded

**The lookup index is fed from the BaseApi REST routes, not from Postgres.**
`tools/sync-entity-names.py` reads `/api/v1/workflows`, `/api/v1/steps` and `/api/v1/processors` and joins them client-side. Postgres-direct would be one query instead of three reads, but it binds a tool to someone else's schema and needs database credentials that nothing else in `tools/` carries — the existing scripts talk to Kafka and to the API over the network, never to a datastore directly. The volume makes the cost irrelevant: this cluster holds 6 workflows, 10 steps in the largest, and 8 processors. Supported interface wins.

**The dashboard's default time range is the last 1 hour.**
Short enough that an operator opening it lands inside the enriched window (§6.3) rather than on GUID-legended history, and long enough to span several cron ticks of a 30-second workflow.

## 12. Declined during design

Recorded so a later reader knows these were weighed and dropped, not overlooked: a failure-reason terms table, a failure-ratio-over-time panel, a heartbeat tile for "the workflow has stopped", step-duration percentiles from `attributes.ElapsedMs`, and a lineage funnel on unique `CorrelationId` per step. The dashboard is deliberately the five things asked for and nothing more; these belong to a second one if the first proves useful.

---

## 13. Amendment 2026-09-22b — the org-cluster redesign

**Status: IMPLEMENTED 2026-09-22.** All of it, verified against the live cluster with every
Elasticsearch object deleted. Three claims in this section were wrong and are corrected in place,
each marked. Execution record:
`docs/superpowers/plans/2026-09-22-kibana-dashboard-offline-redesign.md`.
Originally: The dashboard described by §1–§12 is built, deployed and passing 8 of its 9
checks; this amendment replaces the Elasticsearch half of it and leaves the Kibana half standing.

Sections superseded by this one: **§4.1, §4.2, §4.3, §6.1, §6.3, §6.5, §6.6, §7.1, §9.** Each carries
a banner pointing here. They are kept rather than rewritten because the arguments in them are the
reason this amendment is shaped the way it is, and a reader who only sees the conclusion cannot tell
which parts were load-bearing.

### 13.1 Why the design changes

The system is being ported to an **offline machine where Elasticsearch belongs to the organisation**,
not to this project. That turns three previously-free assumptions into costs:

- `manage_pipeline` and `manage_enrich` are cluster privileges. On someone else's cluster they are a
  request, not a given.
- **`logs@custom` is a single cluster-wide slot**, shared with every other team that ships logs
  through the stock `logs` template. §6.5's argument that it is "unclaimed" was true of *this*
  cluster and is exactly the kind of thing that is not true of a shared one. Claiming it is not a
  small ask, and two teams cannot both hold it.
- An enrich policy plus its lookup index plus the sync script is three more objects a stranger's
  cluster has to carry, each of which has to be restored after any rebuild and none of which lives
  in `k8s/`.

The replacement **removes every Elasticsearch object**: no ingest pipeline, no enrich policy, no
lookup index, no sync script. What remains is a Kibana saved-object export and a change to what the
services log. It requires no Elasticsearch privilege beyond read, and it does not claim any shared
slot.

The two halves below are independent. Either can ship without the other.

### 13.2 Half 1 — names, via a Kibana data-view field formatter

Panels and controls aggregate on the **raw id** (`attributes.StepId`, `attributes.WorkflowId`). A
`static_lookup` entry in the data view's `fieldFormats` maps id to label, applied at render time.

**§6.1 dismissed this option, and that dismissal is wrong for this design.** Its objection was that a
formatter "does not create a field the Controls panel or an aggregation can use". That is true and it
is irrelevant here, because under this design nothing aggregates on the name — the aggregation runs
on the id and only the *rendering* of each bucket changes.

**Verified by experiment on the live Kibana 8.15.5:** both the options-list control and the Lens
legend honour the formatter. Two real GUIDs were mapped and the rest left unmapped;
`split-filefetcher` rendered as its name while unmapped ids stayed raw, in the dropdown and in the
legend both.

Two consequences, one of them a genuine improvement over the design it replaces:

- **It covers all history.** Formatting happens at read time, so the forward-only limitation of
  §6.3 — records indexed before installation keep their GUIDs forever — simply disappears.
- **Free-text search regresses.** Names exist only at render time, so an operator filtering in KQL
  or hunting in Discover must type the GUID. §7.4's keyword caveat is now joined by this one.

Decisions taken:

- **The label is `{name}_{version}`**, in the dropdown and in the panel legend alike.
- **The map is sourced from Elasticsearch, not from the BaseApi**:
  `BaseApi --emits logs--> ES --reader--> Kibana data view formatter`. This drops the BaseApi
  dependency at sync time, which matters on a machine where the API may not be reachable from
  wherever the formatter is generated.
- **Three dropdowns: Workflow / Step / Outcome.** The Processor control is removed (it already was,
  in the built dashboard).

A **writer still has to exist.** Kibana cannot derive a formatter from log records by itself; some
tool reads the id-to-name pairs out of the index and emits the `fieldFormats` block. That is a
generator over `kibana/`, not a live dependency — it runs when entities change, and its output is
committed.

Where the pairs come from: **a processor id-to-name pairing already exists on every processor
record** (`resource.attributes.ProcessorId` + `resource.attributes.service.name`). Workflows and
steps have **no such pairing anywhere** — `WorkflowFireJob` logs ids only. So Half 1 needs a new log
line, in `OrchestrationService`, emitting `{EntityId, EntityName}` per entity at start time. See
§13.6.

**The known wart, stated and accepted.** A formatter is a flat id-to-string map applied to *all*
history, and `Version` is mutable on the same row (`StepUpdateDto` carries it). A version bump
therefore **relabels every historical record**. `{name}_{version}` means "what this entity is called
now", not "what it was called when the record was written". That is a real loss of fidelity and it is
accepted deliberately: the alternative is an as-of join, which is the enrich design being removed.

**The control group needs `ignoreQuery: true`. It does NOT take `ignoreTimerange: true`, and the
first draft of this section was wrong to ask for it.** `ignoreQuery` is what lets a naming record —
which carries no `Result` — supply an option at all, and that part is necessary. Ignoring the time
range as well was justified on the grounds that a stopped workflow should still be selectable, so
that an empty chart could be read as "stopped" rather than "does not exist".

Measured, that trade is bad. Ignoring the time range makes the option lists the whole index: **156
workflows and 780 steps** against a registry of 6 and 42, because the graph has been rebuilt many
times and every rebuild mints fresh GUIDs. Worse, with a 15-minute range selected, four of the six
surviving options were workflows that last ran a **week** earlier — choices that can only produce an
empty panel. A dropdown offering something the chart cannot show is not a feature.

The controls therefore respect the time range, and the lists scale with it: 2 workflows and 13 steps
over 15 minutes, 6 and 40 over 30 days. The original intent survives where it is cheap — widen the
range and the catalogue comes back — without making a 15-minute view lie about what is relevant.

**The dashboard also carries one filter**, `attributes.Result exists OR attributes.EntityName
exists`, which is a superset of the counted set and so bounds the option lists without moving a
count. It is what keeps the wide end honest: at 30 days it gives 6 and 40 rather than 156 and 780.
A filter rather than a query, because `ignoreFilters` is deliberately left false and is the one
parent setting the controls still respect.

**No control setting alone puts a never-run step in a list, and this section originally implied one
would.** A dropdown is populated from the values of ONE field, and the Step control reads
`attributes.StepId`. If a naming record carries a generic `EntityId`, a step that has never run has
no record carrying a `StepId` at all, and no combination of ignore-flags will conjure it into the
list. Two things had to change in §13.6 instead: the id is written under the field name the
execution records already use, and a step's record also carries its `WorkflowId` — without which
chaining under the Workflow control falls back to execution records and the list collapses to steps
that have run.

**Settled by experiment 2026-09-22: omit `unknownKeyValue`.** A map was published with
`split-exporter` deliberately removed; it rendered as its own GUID, `9cae7b00-…`, beside twelve
named siblings. Omitting the setting is what produces that. Setting it to a string would render
*every* unmapped entity as that one string, so two unlabelled steps would collapse into a single
bucket in a legend — tidy and wrong, where a raw GUID is ugly and correct.

### 13.3 Half 2 — counting, by making exporters unexceptional

§4.1's counted set needs **two** clauses for exactly one reason: **terminal-step success is invisible
on the processor side.** An exporter sends no branch, so the post handler never runs and no
`branch completed` is ever emitted. `ProcessDispatchHandler` says so in as many words —
*"NO OutcomeLogScope HERE, DELIBERATELY … recorded on the ORCHESTRATOR side instead"*.

**The decision: every step reports its own outcome, exporters included.** The terminal branch of
`ProcessDispatchHandler` gains an `OutcomeLogScope.BuildScope(StepResult.Completed)` scope around a
log line of its own. Then:

- the counted set collapses to **one clause** — `attributes.Result` present on a record whose
  emitter is not the orchestrator;
- `skp.outcome_record` is no longer needed, so **the ingest pipeline is not needed**;
- **check 5 covers 10 of 10 steps**, because a processor-emitted outcome sits inside the handler's
  ambient `ExecutionLogScope.BuildScope(d)` and therefore carries `d.EntryId`;
- §4.3's **first** argument — that a terminal outcome would otherwise land under `orchestrator` —
  evaporates. Its **second** still stands: `service.name` merges `sk-normalizer`'s two steps and
  `kafka-exporter`'s two steps, so the split field remains an id, now formatted per §13.2.

**Verified:** `service.name != orchestrator` today yields 925 records over **8** of 10 steps.
The two missing are `export-outcome` and `split-exporter` — precisely the gap this change closes.

Two implementation notes, both of which have been got wrong once already:

- **Use `d.EntryId` for the log scope.** The `Guid.Empty` in that branch is about the `StepOutcome`
  **message**, not the log: it stops `StepOutcomeHandler` reading a blob the reclaim just deleted and
  logging a spurious warning. That is a messaging concern and it must not shape what the log records.
  The scope at `ProcessDispatchHandler.cs:56` already carries `d.EntryId`; a new line inside the
  terminal branch inherits it with no new argument.
- **Keep the orchestrator's line.** Its source comment is right that it gives "two independent
  end-of-run markers on two different pods, which matters in a deployment that demonstrably drops log
  records" (§10's last risk row). Under the new rule it simply is not counted. Deleting it would
  trade a redundancy that costs nothing for a single point of failure in the one place §10 says
  records are actually lost.

**One residual gap, smaller than the one it replaces.** A step that is *both* an entry step and a
terminal step has `d.EntryId == Guid.Empty` — it produced its own input, so there is no key — and
`ExecutionLogScope` omits an empty Guid rather than writing zeros. Such a step is uncheckable by
check 5, exactly as kafka-exporter is today. No workflow in the cluster has one; a one-step workflow
would. Check 4's per-processor assertion is the guard, as it is now.

### 13.4 The new counted set — replaces §4.1

A record is counted if it carries `attributes.Result` **and** its emitter is not the orchestrator.

Written as the dashboard-level KQL query:

```
attributes.Result:* and not resource.attributes.service.name:"orchestrator"
```

The structural argument of §4.1 survives intact and gets simpler: it is still a **property test, not
a template list**, so a new framework failure path is counted the day it ships. What changes is that
the exception carved out for terminal steps is gone, because there is no longer anything exceptional
about them.

`scope.name` prefix versus `service.name` — either expresses "not the orchestrator". The
`service.name` form is preferred because it survives a namespace rename in `BaseProcessor.Core` and
because it is the field an operator already recognises.

### 13.5 Where the rule lives — replaces §6.6

In the **dashboard-level query**, once. §6.6 argued for a pipeline-stamped flag on two grounds, and
one of them is now known to be false:

- **"`attributes.{OriginalFormat}` does not quote reliably in KQL" is wrong.** Verified: it escapes
  as `attributes.\{OriginalFormat\}`. §4.1 written directly as KQL returns **1,110** against the
  flag's **1,110** — braces, em dash and all.
- The second ground — that the definition should live in one place rather than being restated across
  four Kibana objects — is satisfied by the dashboard query, which the controls already respect
  (`ignoreQuery: false`). The single place moves from the pipeline to the dashboard.

**What must move before `kibana/` is cut down.** `simulate-outcome-classification.json` is a real
test: twelve documents, one per template of §4, with the expected classification tabulated in the
plan. Three of those templates are the rarely-fired failure paths that §4 exists to protect. If the
rule moves to KQL it needs an equivalent test — the twelve documents indexed into a scratch index and
the KQL run against them — or those three paths go back to being unverified, which is the specific
defect §4 was written to prevent.

### 13.6 What emits the name pairs

`src/BaseApi.Service/Features/Orchestration/OrchestrationService.cs`, between validation (~line 108)
and `SendAsync` (~line 130) — the window where `WorkflowGraphSnapshot` still holds
`WorkflowReadDto`, `StepReadDto` and `ProcessorReadDto`, each carrying `Name` and `Version`
(confirmed: all three records declare both, and the snapshot exposes all three dictionaries).

**Not the orchestrator's handler.** `WorkflowL1` / `StepL1` are ids-only; the names do not survive
the projection. The BaseApi is the last place they exist.

The lookup table is three shapes, and no more than three — schemas, assignments and caches are
deliberately excluded, because no log record anywhere is grouped by their ids:

| kind | fields on the record |
|---|---|
| workflow | `WorkflowId` + `EntityName` |
| step | `StepId` + **`WorkflowId`** + `EntityName` |
| processor | `ProcessorId` + `EntityName` |

`EntityName` is `{name}_{version}` per §13.2, and every record also carries `EntityKind`. The id goes
**under the field name the execution records already use**, never a generic `EntityId`.

**A step carries its workflow's id and a processor does not, and the asymmetry is the point.** The
Step control is chained under the Workflow control, so Kibana narrows its options to records matching
the selected `WorkflowId`. Without that id on the step's naming record the only records left to match
are executions, and the list collapses to steps that have already run — which is precisely the
guarantee these records exist to provide. Measured: before the id was added, selecting a workflow
took the Step list from 40 options to the 10 that had run, and the steps resolvable from naming
records alone under a selected workflow were **0**; after, **10**.

A processor is chained under nothing — there is no Processor control — and is genuinely shared
across workflows, so stamping one workflow on it would pick an arbitrary owner and multiply the rows
for a reader that only ever needs id to name.

**Not a generic `EntityId`**, which is what an earlier draft of this section said. A control reads
one field, so the id has to arrive under the field that control reads or a never-run entity cannot
appear in it (§13.2). `EntityKind` is carried because nothing else in the record says whether the
GUID belongs in the Workflow control or the Step control.

These records carry no `Result`, so the counted set of §13.4 cannot pick them up.

### 13.7 Verification — amends §9

| check | change |
|---|---|
| 1 | unchanged |
| 2 | **deleted** — there is no enrichment to land |
| 3 | **deleted** — there is no lookup to miss |
| 4 | unchanged in shape; `PER_CYCLE_BY_STEP` and `PER_CYCLE_BY_PROCESSOR` keys become `{name}_{version}` |
| 5 | **strengthened to 10 of 10 steps** (§13.3). The uncovered-slice paragraph is deleted; the entry-and-terminal caveat replaces it |
| 6 | unchanged — every processor still has a bin, now via the formatter |
| 7 | unchanged — 26:3:1 per cycle |
| 8 | unchanged — still the one manual click |
| 9 | unchanged, and **still failing** for want of a second driven workflow |
| **new** | the rule classifies the fixture correctly. **Not as KQL:** Kibana exposes no endpoint that evaluates a KQL string on demand, so the check runs the equivalent query DSL and a second check pins the KQL text. Stated as a limitation in the check itself |
| **new** | an unmapped id renders as its GUID, not blank (§13.2's `unknownKeyValue`) |
| **new** | every published step appears in the Step dropdown, including one that has never run |

### 13.8 Risks this amendment adds or retires

| risk | status |
|---|---|
| Enrich policy goes stale after a publish | **retired** — no policy |
| Ingest pipeline error drops documents | **retired** — no pipeline |
| Historical data has no enriched fields | **retired** — read-time formatting covers all history |
| `logs@custom` contended on a shared cluster | **retired** — not claimed |
| A version bump relabels history | **new**, accepted (§13.2) |
| Free-text search must use GUIDs | **new**, accepted (§13.2) |
| `unknownKeyValue` renders a new entity blank | **retired** — omitting it renders the raw GUID, verified |
| The formatter map must be regenerated after a publish | **new** — the same staleness shape the enrich policy had, but the failure is a raw GUID in a legend rather than a confidently wrong name |

### 13.9 Unknowns about the target cluster — unanswered

Stated to the user and still open. Each one can invalidate part of this amendment:

1. Is Kibana already provided, and at what version? §13.2 is verified on 8.15.5 only.
2. ~~Are **data-view edits permitted**?~~ **Answered 2026-09-22: yes.** Half 1 proceeds as written.
   This was the one unknown that could have killed it — without it the names would have had to
   come back into the records themselves, which is a different design.
3. Which **Space** the dashboard lands in — saved-object ids are fixed on purpose, and they collide
   on an import into a Space that already holds them.
4. Is the data stream `logs-generic.otel-default`, and is `all_strings_to_keywords` in force? Every
   field name in the export assumes the first; §7.4 assumes the second.
