# Napole — Design

**Date:** 2026-11-08 · **Status:** draft for review · **Branch at writing:** `feature/ems-exporter`

Napole is a scheduled processor that reports how the executions of a watched workflow ended. On each
tick it asks Elasticsearch which executions the kafka-importer imported in the last *x* minutes,
decides for each one whether its round trip **Failed**, was **Cancelled**, or **Completed**, and hands
one count report per tick to the kafka-exporter, which writes it to a topic.

Sections marked **(decided)** are the user's decisions. Sections marked **(builder's call)** or
*my call* are defaults the builder may change without asking.

---

## 1. Why

The pipeline already logs every step of every execution to Elasticsearch, but nothing turns that trail
into a per-window statement of "this many came in, this many made it, this many were discarded, this
many failed". Napole produces that statement as a fixed-shape record on Kafka, so a downstream
reporting system can take it without reading ES itself.

## 2. Goals, non-goals, anti-goals

**Goals**
- One report per tick, covering the executions imported in that tick's window whose round trip is
  fully known, with four counts that always add up: `output + discarded + failed = input`.
- Napole reads ES only. It does not read the watched workflow's Kafka topics or its data.

**Non-goals**
- Per-execution findings in the output. The report carries counts only (the contract in §6).
- Step-level counts (how many steps failed). If wanted later, they go in as *extra* fields; the four
  mandatory counts stay per execution.
- Catching up missed ticks. No watermark: a tick that does not run leaves its window unreported.
- De-duplicating across ticks. If ticks are closer together than the window, an execution can be
  counted in two reports, and that is accepted **(decided)**.

**Anti-goals — it fails even if it "works"**
- Counts that do not add up to `inputCount`.
- An execution that has not finished, or has no logs, counted as anything.
- Napole counting its own runs, or a run of any other workflow, into the watched workflow's report.

## 3. Where it sits

Napole is the **entry step** of its own workflow, fired by the scheduler on a cron. Its only successor
is a **kafka-exporter** step, whose payload names the topic **(decided)**:

```
[scheduler, cron] → napole  ──report JSON──▶  kafka-exporter → <report topic>
```

The precedent is `Processor.Analyst`: a scheduled entry step that reads ES and sends its finding to
a kafka-exporter. Napole follows its shape throughout (entry-step lineage, ES transport, failure
mapping).

**Lineage.** An entry step is called with `executionId == Guid.Empty`, and both `SendToPostAsync`
and the kafka-exporter refuse an empty id. Napole opens one exactly as the Analyst does
(`AnalystProcessor.cs`, ~line 108): `executionId == Guid.Empty ? NewExecutionId() : executionId`.
The exporter puts that id in the record's `execution-id` header, which leads back to Napole's own run
in ES. *My call:* `NewExecutionId()` rather than a derived id, because the framework documents that a
source step is never replayed, so a random id cannot fork a run.

## 4. The tick

### 4.1 The window (decided)

On a tick, Napole reads its own clock `now` (the dispatch carries no fire time) and snaps the
window to a grid of `windowMinutes`:

```
to    = floor(now − lag, windowMinutes)   // e.g. windowMinutes 10 → 10:40:00, 10:50:00, …
from  = to − windowMinutes
trail = [from, to + trailMinutes)         // where the run's records are looked for
```

*My call:* the snap. Without it, T is whenever the dispatch happens to run, and queue delay, a pod
restart or a redelivery would move the window, leaving a gap (runs never reported) or an overlap.
With it, a tick that runs late still covers the same grid slot. Two ticks in one slot produce the
same window twice, which is the accepted duplicate (§2). A skipped slot stays unreported
(no watermark, §2). The cron should fire **mid-slot** (e.g. `0 5/10 * * * *` for 10 minutes), not on the grid line: on the line, only the lag (60 s) stands between a late dispatch and a silently skipped slot; mid-slot gives about four minutes either way (final review, Important 3). The worked example's "10:51 tick" is `now` = 10:51:00 with a 60 s lag:
floor(10:50:00, 10 min) = 10:50, so the window is 10:40–10:50.

- The window selects executions by **when the kafka-importer imported them**: its
  `imported record {Record} as execution {ExecutionId} from {Origin}` record, at or after `from`
  and before `to`. A fire where the importer imported nothing (Drained, Held) writes no such
  record, so it is not counted.
- **Back-to-back windows (`windowMinutes` = the cron interval)** cover every import exactly once.
  Verified over six consecutive ticks, 09:50–10:50 UTC on 2026-11-08 (§9). Keeping the cron and
  `windowMinutes` in step is the operator's job (§5). When they drift apart, executions land in a
  nearby report, which is accepted (decided, §2).
- **`lag` is required.** The importer fires on the same cron second as Napole and imports about 3 s
  later. Runs then take about 200 ms (p99 210 ms, max 3.1 s over 60k runs). A tick with no lag
  that lands inside a batch sees runs still in flight: replayed at 10:50:03.100, 8 of 9 runs were
  unfinished. With tiled windows, a run left out as unfinished is **never** reported, because the
  next window starts after its import. The lag is what prevents that. Default 60 s. It must also
  absorb ingest delay (OTel collector batching to ES), which has **not been measured** (§11).
- **`trailMinutes`** (default 10) bounds how far after `to` the run's records are looked for. In a
  live tick the trail ends at "now" in practice, because nothing later has been written yet.

### 4.2 Why the window also separates runs

An executionId is **not unique over time**. The importer takes it from the record's `execution-id`
header, the producer computes it from the file, and the same file re-imported on another day gets
the same id. In ES, 24,945 ids were imported twice, all more than a day apart except one: `3d9e352f-…`,
re-imported 4 minutes after its first run failed with S3 "access denied" on 2026-10-26. The time
window is what keeps two runs of one id apart. If the trail of a selected execution contains
**two import records**, it is *Ambiguous* and is left out of the report like an unfinished run.

For the import check only, query B looks back `trailMinutes` before `from`. Without that, a run
imported late in window N and re-imported early in N+1 would look clean in N+1, with some of the
first run's records mixed into its verdict. *My call:* it costs one wider range on one aggregate,
and the case has happened once in the data.

### 4.3 The queries

Three ES|QL statements per tick against `logs-generic.otel-default` (the Analyst's index). All three
are **limited to the watched workflow** (`attributes.WorkflowId == watchedWorkflowId`). That limit
keeps Napole's own records, and every other workflow's, out of the counts.

| | selects | per execution, yields |
|---|---|---|
| A | `service.name == "kafka-importer"`, `attributes.Record IS NOT NULL`, `@timestamp ∈ [from, to)` | the executionIds this tick owns |
| B | those ids, `@timestamp ∈ trail` | imports, hand-offs, step returns, terminal records |
| C | those ids, `@timestamp ∈ trail`, orchestrator records with `attributes.Result ∈ {Failed, Cancelled}` | the outcomes that decide the verdict |

The records relied on, and how each is recognised:

| meaning | service | recognised by |
|---|---|---|
| imported | `kafka-importer` | `attributes.Record` present (template `imported record {Record} as execution {ExecutionId} from {Origin}`) |
| step handed off | `orchestrator` | template starts `handed off` |
| step returned | any processor | template starts `the step returned` |
| branch ended at a terminal step | `orchestrator` | `attributes.StepRole == "terminal"` (`Messaging.Contracts.StepRoles`) |
| step Failed | `orchestrator` | `attributes.Result == "Failed"` |
| step Cancelled | `orchestrator` | `attributes.Result == "Cancelled"` |

**Only `StepRole` is a published contract.** The two template prefixes are log text: if a processor
or the orchestrator rewords them, Napole miscounts silently. *Builder's call:* how to protect that,
e.g. constants in `Messaging.Contracts` beside `StepRoles` that the emitters and Napole share, or a
test that pins the strings.

### 4.4 The verdict (decided)

Each execution selected by A gets exactly one verdict, in this order:

1. **Failed** — any step outcome in its trail is `Failed`. The first failure is what counts, even if
   a failure branch then runs to a terminal step (in this workflow: `record-outcome` →
   `export-outcome` → `skp-failures`, which ends with a terminal `Completed`).
2. **Cancelled** — no failure, and a step cancelled its branch (today: `sk-normalizer` refusing an
   artist not on the whitelist).
3. **Complete** — no failure, no cancel, at least one terminal record, and every hand-off came
   back, i.e. every branch returned. Counted as **distinct entry ids**, not record counts: the
   distinct `attributes.NextEntryId` on the orchestrator's `handed off` records must all appear as
   an `attributes.EntryId` on a processor's `the step returned` record. The framework prefers a
   duplicate to a loss, so a redelivered step can log its return twice, and a strict count would
   leave such a run unfinished forever. *My call, implementing the decision.* That last check is what makes it a *full* round trip in a
   run that fans out: a good file ends **twice**, one terminal per exported document.
4. Otherwise **unfinished**. Also unfinished: *Ambiguous* (§4.2), and an id with no records in its
   trail.

**Unfinished executions are not in the report at all (decided).** `inputCount` counts only the first
three.

## 5. Step payload

**Two fields, and only two (decided):** the target workflow and the time frame. *The field names are
my call.*

```json
{ "watchedWorkflowId": "8cfdbcdb-a7e0-4a7d-9b4d-e4120ccacf02", "windowMinutes": 10 }
```

- Both are required. A missing payload, a missing or empty `watchedWorkflowId`, or a
  `windowMinutes` below 1 is a `FailedException`, as the Analyst does for a missing payload.
- **Matching the scheduler to the time frame is the operator's responsibility (decided).** Napole
  neither sees nor checks the cron. If the two disagree, executions are counted in a nearby
  report: twice when ticks come closer than the window, and never when they come further apart.
  That is accepted. No Studio or publish validation is in scope.

**Everything else is pod configuration** (manifest env, bound to options as the Analyst's
`Analyst:Panels:ElasticBaseUrl` is). It is the same for every Napole step this deployment runs.
*My call*, because it is not the workflow author's to choose:

| key | default | meaning |
|---|---|---|
| `Napole__ElasticBaseUrl` | — (required) | e.g. `http://elasticsearch:9200` |
| `Napole__LagSeconds` | `60` | §4.1 |
| `Napole__TrailMinutes` | `10` | §4.1, §4.2 |
| `Napole__Report__ReporterComponentName` | — (required) | copied into `commonDimentions` |
| `Napole__Report__ReporterSubComponentName` | — (required) | 〃 |
| `Napole__Report__ReporterNetworkName` | — (required) | 〃 |
| `Napole__Report__SrcCode` | — (required) | 〃 |
| `Napole__Report__SagCode` | — (required) | 〃 |

A required option that is missing fails the pod at startup (options validation on start), not a
tick. The index name is a constant, as the Analyst's `PanelRegistry.ElasticIndex`.

## 6. The report (decided)

One JSON document per tick. **The field names are kept exactly as given**, misspellings included
(`commonDimentions`, `mandatoryMeasurments`, `timStampHour`): it is an external contract.

```json
{
  "commonDimentions": {
    "reporterComponentName": "myDepartment",
    "reporterSubComponentName": "myTeam",
    "reporterNetworkName": "myNetwork",
    "reportFromTime": 1794134400000,
    "reportToTime": 1794135000000,
    "insertionTime": 1794135060412,
    "srcCode": "928",
    "sagCode": "LLL",
    "timStampHour": 2026110810
  },
  "mandatoryMeasurments": {
    "inputCount": 80,
    "outputCount": 16,
    "discardedCount": 16,
    "failedCount": 48
  }
}
```

(The real report for the 10:51 UTC tick on 2026-11-08, window 10:40–10:50.)

| field | value |
|---|---|
| `reportFromTime`, `reportToTime` | the window's `from` and `to`, epoch milliseconds, numbers |
| `insertionTime` | when Napole built the report, epoch milliseconds |
| `timStampHour` | **the UTC hour of `reportFromTime`, `YYYYMMDDHH`, as a number (decided)**. The user's example 1794119124704 = 2026-11-08 06:25:24 UTC → `2026110806` |
| `inputCount` | executions in the window with a verdict of Failed, Cancelled or Complete |
| `outputCount` | Complete |
| `discardedCount` | Cancelled during the round trip (e.g. not on the whitelist) |
| `failedCount` | Failed |

**The report is hermetic (decided): `outputCount + failedCount + discardedCount = inputCount`.**
Only executions whose round trip terminated as Failed, Completed or Cancelled are counted, in
`inputCount` and everywhere else. An unfinished or log-less execution is in none of the four.

**Every count is per execution (decided).** Each execution is counted once, under its verdict, so
the identity holds by construction, whatever the workflow's branching. Napole still **asserts** it
before sending, and fails the tick if it does not hold, so a counting bug can never reach the
topic as a plausible-looking report (*my call*). Counting steps or records instead breaks it. For the 10:51 tick, terminal
records alone are 80 (two per good file, plus one per failure-export branch), and the step-level
sum is 144 against 80 executions.

**Nothing finished in the window → no report (decided).** Napole throws `CancelledException`
("no finished executions of {watchedWorkflowId} in {from}..{to}"), so nothing is sent and the
exporter never runs. It must **not** simply return without sending: the framework reports a step
that returns without calling `SendToPostAsync` as **Failed**, at Error
(`ProcessDispatchHandler.cs`, the "one output rule"). Sending an empty branch is no better: the
exporter fails on empty input. Cancelled is the same path the kafka-importer takes for an empty
topic, so in Napole's own workflow an empty window reads as Cancelled, never Failed. *My call,
implementing the decision.*

**Output schema.** A new row `napole-report`, with its definition in
`src/tests/BaseApi.Tests/Schemas/napole-report.json` beside `analyst-finding.json`. It requires both
objects and all their fields, with `additionalProperties: false`. A config row `napole-config`, from
`napole-config.json`, is checked by `ConfigSchemaConformance`. Both are registered as a deploy step,
as the Schemas README describes. *Builder's call:* check the kafka-exporter's `inputSchemaId`. The
Analyst → exporter edge already works with the Analyst's own output schema, which suggests it is
null or permissive.

## 7. Failures

Modelled on `ElasticPanelSource`: anything that would make a count untrustworthy fails the step. A
report is never sent on partial data.

| condition | outcome |
|---|---|
| ES unreachable, timeout, non-2xx, malformed base URL | `FailedException` naming the cause |
| ES\|QL response `is_partial` (send `allow_partial_results=false`) | `FailedException` |
| a query returns as many rows as its `LIMIT` (possible truncation) | `FailedException`. *Builder's call:* paginate instead, or size the limit. Today a 10-minute window holds 80–90 imports |
| no payload, no `watchedWorkflowId`, `windowMinutes` < 1 | `FailedException` |
| nothing finished in the window | `CancelledException`, no send (§6) |

## 8. Layout and deployment

As every other processor:

```
src/Processor.Napole/
  NapoleProcessor.cs  NapoleConfig.cs  NapoleReport.cs  Verdict.cs (rules, pure)
  ElasticTrailSource.cs (the three queries)  ProcessorHost.cs  Program.cs
  Dockerfile  appsettings.json  Processor.Napole.csproj
k8s/46-processor-napole.yaml   (+ kustomization.yaml entry)
```

*Builder's call:* the file split and the manifest's resources. 43-processor-analyst.yaml is the
nearest template, because it also talks to `http://elasticsearch:9200`.

## 9. Evidence this works (ES, 2026-11-08)

Reproduced from ES, plus the Kafka broker, with throwaway scripts in the session scratchpad
(`napole_batch.py`, `napole_report.py`, `confirm_batch.py`, `proof.py`). The builder should turn the
checks into tests, not keep the scripts.

- **Hermetic over a Kafka slice:** `skp-paths` 10:00–10:10 UTC, offsets 51000–51084 = 85 records →
  85 imports in ES, one each, same bodies, no phantoms → 51 Failed + 17 Cancelled + 17 Complete = 85.
  Every export a run claimed is on the broker at that offset, with that run's `execution-id`
  header.
- **Six tiled ticks** (x = 10, lag = 60): 510 imports over the ticks = 510 imports in the hour;
  `skp-paths` offsets 50905–51414 with no gaps and no duplicates; for all 510 runs the batch
  verdict matches an independent per-run query; the identity holds on every tick; failed steps =
  failed executions on every tick.
- **The endings in this workflow,** each about a fifth of runs: Failed at `split-filefetcher`
  (`.dat` not allowed), at `split-archiveexpander` (corrupt zip), at `sk-normalizer-sample` (extra
  file in an item); Cancelled at `sk-normalizer-sample` (artist not whitelisted); Complete via
  `split-exporter` (two documents to `skp-documents`).
- **No real unfinished run exists in ES.** Every one of ~62k historical runs ended. The unfinished
  path has only been exercised by replaying a tick inside an in-flight batch.

Sample executionIds for fixtures: Complete `ffaa1edc-2c11-5a00-a4cb-462badd84c25`; Failed
`81e030ce-5fee-5f07-b8b8-f23fdc318c51` (fetcher), `632aac12-c70f-587d-9991-d500b9db9ee5` (expander),
`fffcd026-b90a-5201-976c-5325858b9067` (normalizer); Cancelled
`ffd1e02a-d50b-56df-8a82-32059ffb120d`; re-imported within 5 min `3d9e352f-79dd-554f-9896-68247feb3119`.

## 10. Tests (builder's call on the shape)

- **Verdict rules, pure:** fixtures of trails for each ending, including a fan-out run with one branch
  still open (unfinished, not Complete), a run whose failure branch completes (Failed), a run that
  both cancels and fails on different branches (Failed), and two imports in one trail (left out).
- **Report:** the identity on every fixture; `timStampHour` across an hour and a day boundary in UTC;
  the exact field names; no send when nothing finished.
- **ES transport:** the `ElasticPanelSource` failure cases (unreachable, partial, non-2xx).
- **Live:** run it on the dev cluster beside the split chain, and check one tick's counts against
  the same window computed independently, as §9 did.

## 11. Open, for the builder to settle or raise

- **Ingest delay is unmeasured.** Compare `@timestamp` with the time records become searchable,
  e.g. by polling for a known import, before trusting 60 s as the default lag.
- **Template strings as contract** (§4.3).

## 12. Rejected shapes

- **Napole reads `skp-paths` (or the exporter's topics) through a kafka-importer step and gets each
  executionId from the `execution-id` header.** Superseded by the scheduled ES query. It would also
  have needed its own consumer group, which starts at `earliest` and replays ~52k historical records,
  and two groups on one importer instance rebuild the cached consumer on every alternation.
- **One record per execution.** The reporting contract is a count report per tick.
- **Counting steps or records.** It breaks the identity (§6).
