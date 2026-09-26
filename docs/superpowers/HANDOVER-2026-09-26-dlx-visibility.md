# Handover — 2026-09-26 — dead-letter visibility, and what it uncovered

Branch `feature/path-importer`. Nine commits, `b7c9ad7`..`d45356f`, all on top of `1d2dbb8`.

The session started as "put dead-lettered messages on the ES dashboard" and turned into four
framework fixes, because asking *why can't anyone see a parked message* kept finding things that
were invisible on purpose or by accident.

---

## THE ONE THING TO READ FIRST

**The agent's panel set and the operator's dashboards have drifted, and nothing detects it.**

The stated design intent, written in five places in the code
(`ProcessorRow.description`, `ContractPrompt`, `PanelDefinition`, `IPanelReader`,
`AnalystConfig.WindowMinutes`), is that the Analyst reads *the same panels an operator reads* —
same query, same data, same window, only the rendering differs. The agent never reads Kibana or
Grafana; each `PanelDefinition` is a hand-written C# re-expression of a dashboard panel. **Two
clients, one database, agreeing only because a human kept them agreeing.**

Audited this session: the operator has 5 Kibana panels and ~60 Grafana panels over ~14 distinct
`pipeline_*` metrics. The agent has 7 panels. **Nine metrics the operator can see have no agent
counterpart**, three of which are the agent's own recurring failure modes — it can observe "queue
wait rose" and cannot see that the gate was shut, the queue was backed up, or a pod restarted in
the same window.

| Missing metric | Operator panel | Agent blind to |
|---|---|---|
| `pipeline_gate_open_ratio` / `_gate_trips_total` | Gate open, Gate trips by replica | **whether L2 was down** |
| `pipeline_queue_depth` | Queue depth by queue | **backlog** |
| `pipeline_process_start_timestamp_seconds` | Restarts | **pod restarts** |
| `pipeline_messages_consumed_total` | Messages consumed by disposition | **requeue storms** |
| `pipeline_messages_produced_total` | Produce faults | send failures |
| `pipeline_queue_consumers` | Consumers attached | a queue with no consumer |
| `pipeline_gate_probe_duration_seconds` | Gate probe duration | store latency |
| `pipeline_leader_ratio`, `pipeline_hydration_admitted_ratio` | Leader, Hydration | orchestrator role state |
| — | whole `skp-baseapi` board | 5xx, p95, exception rate |

Plus two Kibana panels with no counterpart: **Refused messages** (created this session — I broke
the pair myself) and **Whitelist verdicts by value**.

### Proposed next work, in order

1. **`refused-messages`** (business, Elastic) — closes the pair broken this session. Design is
   written up below.
2. **`gate-open`, `queue-depth`, `restarts`** (ops, Prometheus) — the three that explain what the
   agent already observes.
3. **`messages-consumed-by-disposition`** — requeue storms.

**Write the maintenance rule into `PanelRegistry`'s doc comment**: a panel added to an operator
dashboard needs its `PanelDefinition` counterpart, or the shared language has a hole. Nothing
enforces this today and it is the thing that will rot again.

### `refused-messages` design (not built)

```
PanelId "refused-messages", Layer "business", Kind Elastic
```
`_search` on `logs-generic.otel-default`, filters: `{{FROM}}`/`{{TO}}` range, `term
attributes.WorkflowId = {{WORKFLOW}}`, `term severity_text = Error`, `terms
attributes.{OriginalFormat} = [the two park templates]`.

- aggs `by_queue` and `by_outcome` (the template field — parked vs NOT-parked)
- **plus up to 5 most recent records** carrying `attributes.exception.type`,
  `attributes.exception.message`, `Queue`, `Type`, `StepName` — mirroring `step-failures`'
  shape. The exception is *why* it was refused and is the most useful field.
- **NOT `attributes.exception.stacktrace`** — a successful `read_panel` result enters the
  transcript untruncated (that is why `MaxTokenBudget` exists); five stack traces would be a
  large, low-value chunk of budget.

**Do the constants hoist first.** The two park template strings currently exist in four places:
`BaseConsole.Core/Messaging/GatedQueueConsumer.cs`, its `BaseApi.Core` twin,
`src/tests/BaseApi.Tests/Live/Resilience/Templates.cs` (`RefusingAndParking` /
`RefusingNotParked`), and `kibana/kibana-export.ndjson`. Hoist to `Messaging.Contracts`, which
both `BaseConsole.Core` (the logger) and `Processor.Analyst` (the panel) reference. A `const
string` still satisfies structured logging and CA2254.

**Why it earns its place next to `dead-letter-depth`** — they disagree on purpose:
depth is a *level* (still sitting there, no attribution); refusals are *events* (this window,
scoped to the workflow). `depth > 0` with no refusals in window = old unresolved loss;
refusals in window = losing work *now*. The agent currently sees only the first number.

---

## WHAT SHIPPED

### Kibana — the operator's refusal panel
`b7c9ad7`, `f149e51`, `ddf3c18`, `d45356f`

`skp-parked-table` — *"Refused messages — what was lost, and whether it reached a dead-letter
queue"* — sits beside the outcome pie, half width each. A second panel (`skp-parked-bins`, a bar
chart) was built and then removed: two panels answered one question.

- The **dashboard's own query and filter had to widen** — both previously admitted only records
  with `attributes.Result` or `attributes.WhitelistVerdict`, and they AND with every panel query,
  so the panel rendered permanently empty until a third clause existed.
- Selector is **two clauses doing different jobs**: the KQL query stays a shape
  (`severity_text:"Error" and attributes.Queue:*`), the DSL filter is an identity (the two
  templates). Braces cannot go through KQL — that is the only reason the field was avoided in
  the query. Measured: shape matches 2 against one real park + one stray Error-with-a-Queue,
  identity matches 1.
- The **Outcome column is two labelled buckets, not the raw template** — found by screenshotting.
  Terming on `{OriginalFormat}` truncated to `refusing message of type {Type} o` for *both*
  variants, destroying the only distinction the column exists to make. Splits on a `body.text`
  phrase match (`match_only_text`, so it answers a phrase query; the `attributes.*` fields are
  all `keyword` where a match returns zero silently).
- `missingBucket: true` on every dimension — a refusal with no workflow id is lost work the board
  would otherwise report as absent. 9 of the 10 live parked messages carry the id; the 10th
  predates the header stamping.

Gate: `python tools/verify-kibana-dashboard.py` → **0 of 10 failed**. `DASHBOARD_KQL`,
`REFUSED_KQL` and `PANEL_GUARDS` in that script are the pinned contract; fixture docs 14 and 15
in `tools/classification-fixture.json` cover the park branch, which never fires in traffic.

### Analyst — `dead-letter-depth` panel
`af666bc` — **deployed**

`max by (queue) (pipeline_deadletter_depth)`. **max, never sum**: every replica probes the same
shared queue, so `sum by (queue)` turned a real depth of 10 into 30 (I made that mistake live).
Pinned by a test.

Its description **inverts the caveat every other ops panel carries**: this probe publishes 0
explicitly for a queue it read and found empty, so a present zero *is* a confirmed all-clear —
while an **absent** series means nothing is probing that queue. Read the usual way round, a
missing queue reads as a healthy one.

Also updated `docs/task-16-analyst-monitor.http` (`panelSet` + prompt) and pushed the assignment
payload from that file to the live row.

### Framework fixes
| Commit | Fix |
|---|---|
| `e9dc652` + `45d6dbd` | Error log when a non-terminal step returns without `SendToPostAsync`. A **diagnostic, not a guard** — your call: the author is responsible, the framework only makes the breakage visible. `MaySendNoBranch` (sealed true on `BaseImporter`) exempts sources; without it the check fired on every drained importer poll. |
| `b069eb5` | **RPC replies now match the ask.** See below — the most serious find of the session. |
| `63696ad` | `WorkflowFireJob` checks the L2 gate **before** the leader check. |

---

## THE RPC CROSSING (`b069eb5`) — read if anything schema-related looks wrong

Replies were published into the process's single shared `ReplySlot` on **message type alone**. The
correlation id was minted, sent, echoed by `RpcQueueConsumer` — and never read. A late answer to a
timed-out ask was handed to whoever asked next, undetectably, because a reply body carries nothing
saying what it answers.

Found live: `processor-filefetcher` at 14:14:04 asked for its **config** schema and received the
**output** schema's definition, fetched one request earlier. The conformance check caught it only
because it compares against a C# type — the one check with an independent reference. **The output
definition stored moments earlier was crossed the same way and nothing noticed**, because
`SetDefinition` trusts the pairing and `"definition resolved for {Role} schema {SchemaId}"` logs
what was *asked*, not what came back. Input/output definitions validate every payload on every
dispatch.

Fixed in the slot: `Expect(correlationId)` before the send, `Publish(reply, correlationId)`
refuses a mismatch, `Take()` clears the expectation. Four new tests.

**Still open, optional:** `SchemaDefinitionFound(string Definition)` carries no schema id, so the
crossing was undetectable by construction. Correlation matching closes it at the transport, which
is the right layer — but echoing the id on the reply would make it impossible to reintroduce.

---

## LIVE STATE

- **All 12 images rebuilt, loaded, rolled.** 17 pods `1/1 Running`, 0 restarts.
- **Roll in this order**: `baseapi-service` → wait Ready → `orchestrator` → processors. Rolling
  all at once starved the schema loop and the liveness probe killed `processor-filefetcher`.
- `analyst-monitor` workflow **STOPPED** (stopped at user request early in the session; the
  Moonshot key is spent so it cannot dispatch anyway). Assignment `panelSet` already updated — it
  takes effect at next workflow start, no extra step.
- Analyst processor row `f361e170-…` sourceHash repointed to
  `90c3a7100286dfddcdcd6db2179e21401f15bb331c298d010f651af9f45a6484`.
- `orchestrator-result.dead` holds **10 messages from 2026-09-01**. The ES data stream's only
  backing index was created 2026-09-23, so they will **never** appear on the Kibana panel at any
  time range. They do appear in `pipeline_deadletter_depth` and in the agent's new panel.
- **No Grafana alert rules exist at all** (`groups: 0` from both ruler APIs). The single highest
  value remaining fix is an alert on `max by (queue) (pipeline_deadletter_depth) > 0`, `for: 5m`.
  The metric, the dedupe expression and the panels all already exist.
- `simulate-endless-feed.py` running since 01:15 (PID 28640, parent `py.exe` from a prior
  session). **Do not start a second** — two producers independently wipe `in/`+`out/` at the
  50-file threshold and every role degrades into a fetch failure.
- Port-forwards: Kibana 15601, BaseApi 18080, ES 19200, Prometheus 19090, Kafka 19092 all up.
  **Grafana 13000 was reaped three times** by the low-memory watchdog. If it keeps dropping,
  launch Claude Code with `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1` (must be in the
  environment at launch; a shell command has no effect).

---

## GOTCHAS PAID FOR THIS SESSION

- **The tests consume the frameworks as PACKAGES, not project references.** A framework edit is
  invisible to the test run until `bash scripts/pack-all.sh`. This bit twice: the first run of the
  new `ProcessDispatchHandler` tests passed against a stale `BaseProcessor.Core` and reported the
  check missing. The repack rewrites 5 `.nupkg` and **17** `packages.lock.json` — they commit
  together or restore fails NU1403.
- **`L2Gate` starts CLOSED** (`_isOpen = false`, fail-closed until the probe's first healthy
  measurement). Correct in production, wrong as a test default — left shut it made **ten**
  existing `WorkflowFireJobTests` pass for the wrong reason.
- **A framework edit moves no processor SourceHash** — the fold is project-only. Verified: the
  Analyst's hash was identical before and after. No row repointing needed for framework changes;
  a change inside `Processor.Analyst/` does move it.
- **Verify a rebuilt image by reflecting on the DLL inside it**, not by trusting the build. The
  Dockerfile warns the SourceHash fold runs on Linux there and Windows here.
- **Narrow ES time windows read exactly like a dead pipeline.** A query for "outcomes since
  15:39:00Z" run at 15:39:07 returned 0; widened to 10 minutes it was 948.
- Kibana **9.3.4** in dev (not 8.15.5); Grafana **12.3.9**. The 8.15.5-stamped export imports
  cleanly into 9.3.4.
- `SendTransientAsync` is an **extension method** — cannot be substituted; stub
  `IQueueSender.SendAsync`. `Recorded<T>` **is** the list (no `.Items`). `LogLevel` needs
  `Microsoft.Extensions.Logging`.
- ES writes for verification: inject **marked** records (`attributes.SyntheticProbe`), verify,
  `_delete_by_query`, confirm 0 remain. Done three times this session; store is clean. **Ask
  first** — this was flagged and never explicitly approved.

---

## UNCOMMITTED, NOT MINE

`kibana/publish-diagram.py` (modified), `grafana/shot-diagram.js`,
`docs/superpowers/specs/2026-09-26-diagram-legend-wrapping-design.md`,
`src/BaseApi.Service/Properties/launchSettings.json`, and the `skp-toolkit/` deletions — all
pre-date this session. Untouched.
