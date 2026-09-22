# Kibana Operator Dashboard — Generic Workflow Step Outcomes

**Date:** 2026-09-22
**Status:** Design agreed, awaiting review before planning

## 1. Goal

One Kibana dashboard an operator opens to answer, for any workflow: *is it running, and if something is wrong, which step is it?*

It shows step outcomes binned over time — one coloured bin per participating processor — beside a pie of the outcome distribution, and lets the operator click through to the logs behind any slice.

The dashboard is **generic**. It is not built for `filefetcher-archiveexpander-chain`; that workflow is only the one it is validated against. A workflow published next month appears in its dropdown with no dashboard change.

## 2. Scope

**In:** a Kibana 8.15.5 deployment; an ingest-time enrichment pipeline that resolves entity GUIDs to names and marks outcome records; a lookup index and enrich policy fed from Postgres by a new `tools/` script; one data view; one dashboard with four controls, a bins chart, a pie, and a drill-down to a saved search.

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

A record is counted if **either**:

- its `scope.name` starts with **`BaseProcessor.Core.Processing.`** and it carries `attributes.Result` — any template, any `Result`; **or**
- its `scope.name` is **`Orchestrator.Messaging.StepOutcomeHandler`**, its template is the **terminal-step** one, *and* `Result` is `Completed`.

The first clause is a prefix test rather than a template list precisely so a **new** framework failure path is counted the day it ships. Every `OutcomeLogScope` call site in `src/` lives in `BaseProcessor.Core.Processing`; no processor emits the scope itself, so the framework owns the vocabulary and the prefix is a complete description of the processor side. Verified against the index: `scope.name` partitions the Result-bearing records cleanly into `ProcessedDataHandler`, `ProcessDispatchHandler` and `StepOutcomeHandler`, with no service emitting under more than its own.

The second clause must still name a template, because all three orchestrator templates share one scope and two of them are duplicates. That list is short and stable — one file, `StepOutcomeHandler`.

**Excluded:** `the entry step completed with {Result}` and `advancing … on a {Result} step`. Both restate an outcome the processor side already emitted for the same step and lineage.

**Also excluded: terminal-step records whose `Result` is not `Completed`.** This qualifier is not tidiness, it is a correctness fix found during spec review — see §4.2.

### 4.2 Why the terminal-step template is in, and why only its Completed half

A step that hands on no output never emits `branch completed`. Measured: **8 of the chain's 10 steps** appear in the processor-emitted set; the two missing are both `kafka-exporter` steps, and `kafka-exporter` contributes **zero** processor-emitted records.

The orchestrator's terminal-step record recovers them. But breaking that template down by result and processor shows it carries two different things:

```
Result=Completed  230   ProcessorId=157a0f40-…   ← kafka-exporter
Result=Cancelled   46   ProcessorId=1673b377-…   ← sk-normalizer
```

The Completed half is **new information**: the exporter's outcome exists nowhere else. The Cancelled half is a **restatement**: `1673b377-…` is sk-normalizer, which already emitted `the author cancelled the branch: {Reason}` for the very same step and lineage. Counting the whole template double-counts every cancellation — 46 of them in the measured window.

The generic rule behind the qualifier: **`Failed` and `Cancelled` are always emitted by the processor that produced them** (`the author reported…`, `the author cancelled…`), so the orchestrator's copy is never the only witness. `Completed` is the one outcome a processor may not emit, because `branch completed` needs output to hand on and a terminal step produces none. So the terminal template is needed for `Completed` alone.

Measured, no step is witnessed twice under this rule: the 8 `StepId`s in the processor-emitted set and the 2 in the terminal-Completed set do not overlap. §9 check 5 is the regression test for that, and it is the check that would have caught this defect.

### 4.3 Consequence: the split field is `ProcessorId`, not `service.name`

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
Postgres (workflows, steps, processors)
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

**Enrichment applies only to newly indexed documents.** Everything already in the index keeps its GUIDs, and no reindex is planned. The dashboard is useful from the day the pipeline is installed, forward only. An operator looking at a range that predates installation sees GUIDs in the legend.

**Enrich reads a point-in-time snapshot of the lookup index.** Adding a row is not enough — the policy must be re-executed, which rebuilds the internal `.enrich-*` index. A workflow published after the last sync shows GUIDs until `tools/sync-entity-names.py` runs. This is why the sync script re-executes the policy as its final step rather than leaving it to the operator.

### 6.4 What would retire this

Emitting `WorkflowName`, `StepName` and `ProcessorName` as log attributes alongside the ids, in `BaseProcessor.Core` and the orchestrator's `StepOutcomeHandler`. Then there is no lookup index, no policy, no sync script and no staleness window. It is a code change across two projects and a redeploy of every processor, which is why it is not in this slice — but it is the better end state, and the enrich fields are named `skp.*_name` so that a later switch is a data-view change rather than a dashboard rewrite.

### 6.5 `logs@custom`

Created, not edited: nothing managed is modified, and an Elasticsearch upgrade that replaces `logs@default-pipeline` keeps calling `logs@custom` because the call is part of the stock pipeline. Processors, in order:

1. `enrich` `attributes.WorkflowId` → `skp.workflow_name`, `ignore_missing: true`
2. `enrich` `attributes.StepId` → `skp.step_name`, `ignore_missing: true`
3. `enrich` `attributes.ProcessorId` → `skp.processor_name`, `ignore_missing: true`
4. `set` `skp.outcome_record: true`, conditioned per §4.1 — `scope.name` prefixed `BaseProcessor.Core.Processing.` with `attributes.Result` present, **or** `StepOutcomeHandler` + the terminal-step template + `Result == "Completed"`. The condition is a single painless `if`. Two things in it are load-bearing: the processor half must be a **prefix test, not a template list**, or the three rarely-fired failure templates of §4 are silently uncounted; and the terminal half must test `Result`, or every cancellation is double-counted (§4.2).
5. `remove` the intermediate enrich target objects

`on_failure` sets `skp.enrich_error` and lets the document through. **A logging pipeline must never drop a log because a lookup missed**; a silently discarded error record is worse than an unresolved GUID.

### 6.6 `skp.outcome_record`

The flag exists so the dashboard's filter is `skp.outcome_record: true` rather than a template match. Two reasons:

- `attributes.{OriginalFormat}` does not quote reliably in KQL. The braces are a field-name character, and every dashboard filter, control and saved search would have to be written as raw Query DSL to avoid them.
- The definition of "an outcome record" then lives in **one** place — the pipeline — instead of being restated in four Kibana objects that can drift apart.

## 7. The dashboard

### 7.1 Controls

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
| 3 | `tools/sync-entity-names.py` | Postgres → `skp-entity-names`, then re-execute the policy |
| 4 | `elastic/enrich-policy.json` | `skp-entity-lookup`, match on `entity_id` |
| 5 | `elastic/logs-custom-pipeline.json` | the `logs@custom` body of §6.5 |
| 6 | `elastic/kibana-export.ndjson` | data view, 2 Lens panels, saved search, dashboard |
| 7 | `docs/testing/kibana-operator-dashboard.md` | operator notes, including §4.4 and the keyword caveat |

Kibana saved objects are exported as NDJSON and imported by hand, matching how the Grafana dashboards are handled in this repo — hand-edited JSON, hand-imported, no provisioning ConfigMap.

## 9. Verification

Against the running simulator, which produces a known outcome mix every 30 seconds:

1. **Kibana reaches ES** — status green, data view resolves, document count non-zero.
2. **Enrichment lands** — a document indexed after installation carries `skp.workflow_name`, `skp.step_name`, `skp.processor_name` and `skp.outcome_record`.
3. **Unmatched ids survive** — index a record with a GUID absent from the lookup; the document is present, `skp.*_name` absent, no `skp.enrich_error` beyond the expected.
4. **No double counting, by total** — records where `skp.outcome_record: true`, over N cycles, equals `30 × N` (§4.4).
5. **No double counting, by witness** — no `(StepId, ExecutionId)` pair carries more than one counted record. This is the structural version of check 4: it fails even when two errors cancel out in the total, and it is the check that would have caught the terminal-Cancelled defect of §4.2.
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
| ES is unmanaged in `k8s/` | Kibana is manifested against a dependency that is not | called out in §2 as an explicit non-goal, not an oversight |

## 11. Decisions taken, with the alternative recorded

**The lookup index is fed from the BaseApi REST routes, not from Postgres.**
`tools/sync-entity-names.py` reads `/api/v1/workflows`, `/api/v1/steps` and `/api/v1/processors` and joins them client-side. Postgres-direct would be one query instead of three reads, but it binds a tool to someone else's schema and needs database credentials that nothing else in `tools/` carries — the existing scripts talk to Kafka and to the API over the network, never to a datastore directly. The volume makes the cost irrelevant: this cluster holds 6 workflows, 10 steps in the largest, and 8 processors. Supported interface wins.

**The dashboard's default time range is the last 1 hour.**
Short enough that an operator opening it lands inside the enriched window (§6.3) rather than on GUID-legended history, and long enough to span several cron ticks of a 30-second workflow.

## 12. Declined during design

Recorded so a later reader knows these were weighed and dropped, not overlooked: a failure-reason terms table, a failure-ratio-over-time panel, a heartbeat tile for "the workflow has stopped", step-duration percentiles from `attributes.ElapsedMs`, and a lineage funnel on unique `CorrelationId` per step. The dashboard is deliberately the five things asked for and nothing more; these belong to a second one if the first proves useful.
