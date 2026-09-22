# Handover: the Kibana operator dashboard is built — and a redesign is agreed but unwritten

Date: 2026-09-22
Branch: `feature/path-importer`
Commits: `3248a88` (plan) through `a48d64c` (latest), ten in total
Spec: `docs/superpowers/specs/2026-09-22-kibana-operator-dashboard-design.md`
Plan: `docs/superpowers/plans/2026-09-22-kibana-operator-dashboard.md` (has an execution record at the end)
Operator notes: `docs/testing/kibana-operator-dashboard.md`

## Read this first

Two things happened this session and they point in different directions:

1. **The dashboard was built, verified and committed.** It works. All six plan tasks are done.
2. **A conversation afterwards concluded the whole Elasticsearch-side approach should be replaced.**
   That redesign is agreed with the user in detail, **verified by experiment**, and **not written
   down anywhere except this file.** No spec amendment, no plan, no code.

So do not "finish" the dashboard — it is finished. The open work is the redesign in §"The agreed
redesign", and the user's last instruction was that a spec amendment and plan should be written.

## Live state — nothing here is idle

| what | where | note |
| --- | --- | --- |
| the feed | background task `bhctbj6s6` | 5 files / 30s, endless, ~300 cycles in |
| Grafana forward | background task `b3oi5iu7d`, `localhost:13000` | **unsupervised** — will not respawn |
| Kibana forward | `k8s/port-forward-realstack.ps1`, `localhost:15601` | supervised, 8th entry, added this session |
| Kibana | `k8s/24-kibana.yaml`, pod in `skp` | deployed this session |

Earlier in the session the host's low-memory reaper killed a previous feed and Grafana forward. If
it happens again you will get a task notification; **do not restart them unasked**. The user
explicitly asked for these two to be started, which is why they are running.

A killed background task can leave an orphan runner. Verify the process tree before relaunching —
and `pkill` does not exist on this machine.

## What was built (and is live in the cluster)

| artifact | what |
| --- | --- |
| `k8s/24-kibana.yaml` | Kibana 8.15.5, ClusterIP, pinned to the ES version |
| `elastic/logs-custom-pipeline.json` | `logs@custom` — 3 enrich lookups + the `skp.outcome_record` rule |
| `elastic/enrich-policy.json`, `elastic/entity-names-index.json` | the GUID→name lookup |
| `elastic/simulate-outcome-classification.json` | 12-document fixture; the pipeline's test suite |
| `elastic/kibana-export.ndjson` | data view, 2 Lens panels, saved search, dashboard |
| `tools/sync-entity-names.py` | BaseApi REST → lookup index → re-execute policy |
| `tools/verify-kibana-dashboard.py` | §9 checks 1–7 and 9, executable |

**Live ES objects that exist only in cluster state, not in `k8s/`:** the `logs@custom` pipeline, the
`skp-entity-lookup` enrich policy, and the `skp-entity-names` index. A cluster rebuild restores
Kibana from kustomize but **not** these. `elastic/README.md` has the install order, and the order
is load-bearing (ES rejects an `enrich` processor naming a policy that does not exist).

Dashboard: `http://localhost:15601` → Dashboards → **SKP — workflow step outcomes**.
Controls are Workflow / Step / Outcome (Processor was removed). Bins are ten clustered bars, one
per step, ordered by first-fired. Pie is Completed green / Failed red / Cancelled amber.

## Verification status

`python tools/verify-kibana-dashboard.py --window now-10m` → **8 of 9 pass.**

Only **check 9** fails, and it is about traffic rather than the dashboard: it wants counted records
under two or more workflow names, and only `filefetcher-archiveexpander-chain` is being driven. All
six workflows have crons; the other five are stopped and need an explicit start.

Measured repeatedly and exactly: **30 counted outcomes per cycle**, split 26 : 3 : 1, and the
per-step table below sums to 30.

| step | per cycle | processor |
| --- | --- | --- |
| split-filefetcher | 5 | file-fetcher |
| split-importer | 5 | kafka-importer |
| split-archiveexpander | 4 | archive-expander |
| export-outcome | 3 | kafka-exporter |
| record-outcome | 3 | outcome-recorder |
| sk-normalizer-sample | 3 | sk-normalizer |
| split-archivecollapser | 2 | archive-collapser |
| split-exporter | 2 | kafka-exporter |
| split-filepersister | 2 | file-persister |
| sk-normalizer-alphabeta | 1 | sk-normalizer |

## Facts that were expensive to establish — do not re-derive these

**The spec's check 5 key was wrong, and is now fixed.** It specified `(StepId, ExecutionId)`. The
chain fans out, so one step legitimately completes several times inside one execution —
`split-filepersister` runs twice per cycle under a single `ExecutionId`. Measured: the two-field key
reported ~15 false duplicates per 10 minutes on a healthy run. The key is now
`(StepId, ExecutionId, EntryId)`, which gives zero. §4.2 and §9 of the spec were amended.

**`attributes.role` is a dead end.** Terminal records differ by `role: leader|follower` and it looks
like two replicas logging the same outcome. It is not: `OrchestratorQueues.Result` is a shared
competing-consumer queue, deliberately not leader-gated, so `role` only records which replica took
that branch. Filtering to `role=leader` drops real outcomes — measured, leader covered 12 of 27
distinct pairs.

**Terminal-`Completed` records carry no `EntryId`**, so check 5 skips them (currently 8 of 10 steps
checked exactly; the other two are guarded numerically by check 4's per-processor assertion). This
is a direct consequence of `ProcessDispatchHandler` sending `Guid.Empty` for the terminal
`StepOutcome`, deliberately, because the reclaim already deleted that key.

**`logs@custom` costs 0.0264 ms/doc** and runs on 100% of documents (measured 721/721 over a timed
75s window, zero failures). A first reading after install looks ~20x worse — that is one-off
painless compilation and the counter does not move again.

**The kind node cannot pull `docker.elastic.co`,** and both `kind load` paths fail on Docker
Desktop's containerd image store. The working sequence is `docker save --platform linux/amd64`
first; it is recorded in the header of `k8s/24-kibana.yaml` and in memory.

**BaseApi's service name in ES is `baseapi`, not `base-api`.** It exports ~1,199 records / 2h and
already has `IncludeScopes = true` and `ParseStateValues = true`.

**A processor id→name pairing already exists on every processor record** —
`resource.attributes.ProcessorId` + `resource.attributes.service.name`. Workflows and steps have no
such pairing anywhere; `WorkflowFireJob` logs ids only.

## The agreed redesign — this is the open work

The user is porting to an **offline machine where Elasticsearch belongs to the org**. That makes the
current approach expensive: it needs `manage_pipeline` and `manage_enrich`, and it claims
`logs@custom`, which is a single cluster-wide slot shared with every other team.

The agreed replacement removes **every Elasticsearch object**. Two independent halves:

### Half 1 — names, via a Kibana field formatter

Panels and controls aggregate on the **raw id** (`attributes.StepId`). A data view `static_lookup`
`fieldFormats` entry maps id → label, applied at render time.

**Verified by experiment this session:** both the options-list control *and* the Lens legend honour
the formatter. I mapped two real GUIDs and left the rest unmapped; `split-filefetcher` rendered as a
name while unmapped ids stayed raw, in both places.

This also **covers all history**, because formatting happens at read time — the forward-only
limitation of the current design disappears.

**§6.1 of the spec dismisses this option.** That dismissal is wrong for this design: it objects that
a formatter "does not create a field the Controls panel or an aggregation can use", which is true
and irrelevant, because here the aggregation runs on the id.

Decisions the user made explicitly:

- The label is **`{name}_{version}`**, in the dropdown and in the panel legend.
- The map is sourced **from ES, not from BaseApi**: `BaseApi --emits logs--> ES --reader--> Kibana
  data view formatter`. This drops the BaseApi dependency at sync time.
- Dropdowns are **Workflow / Step / Outcome**. No Processor dropdown.

**Told to the user and unresolved:** a writer still has to exist — Kibana cannot derive a formatter
from log records by itself. And because a formatter is a flat `id → string` map applied to all
history, and `Version` is mutable on the same row (`StepUpdateDto` carries it), a version bump
**relabels every historical record**. `{name}_{version}` therefore means "what it is called now",
not as-of-write-time.

To make **all** steps appear in the dropdown regardless of whether they ran, the control group needs
`ignoreQuery: true` and `ignoreTimerange: true` — otherwise entity records are filtered out by the
counting query, and vanish once the orchestration start scrolls out of the time range.

### Half 2 — counting, by making exporters unexceptional

Today the counted set needs a two-clause rule because **terminal-step success is invisible on the
processor side**: an exporter sends no branch, so the post handler never runs.
`ProcessDispatchHandler` says so explicitly — *"NO OutcomeLogScope HERE, DELIBERATELY … recorded on
the ORCHESTRATOR side instead"*.

The user's decision: **every step reports its own outcome, exporters included.** Then:

- the rule collapses to one clause — `attributes.Result` from a service that is not the orchestrator
- `skp.outcome_record` is no longer needed, so the ingest pipeline is not needed
- check 5 covers **10 of 10** steps, because a processor-emitted outcome carries `d.EntryId`
- §4.3's first argument (terminal outcomes landing under `orchestrator`) evaporates; its second
  (`service.name` merges `sk-normalizer`'s and `kafka-exporter`'s two steps each) still stands

**Verified:** `service.name != orchestrator` today yields 925 records over **8** of 10 steps —
`export-outcome` and `split-exporter` are missing, which is exactly the gap this change closes.

**Verified:** §4.1 written directly as KQL returns 1,110 against the flag's 1,110, braces and em dash
included. §6.6's claim that `attributes.{OriginalFormat}` "does not quote reliably in KQL" is wrong —
it escapes as `attributes.\{OriginalFormat\}`. So the rule can live in the **dashboard-level query**,
once, which the controls already respect (`ignoreQuery: false`).

Two implementation notes:

- Use `d.EntryId` for the **log scope**. The `Guid.Empty` in that branch is about the `StepOutcome`
  **message** — it stops the handler reading a reclaimed blob and logging a spurious warning. The
  user's position, which is correct, is that this distinction should not shape the design.
- **Keep the orchestrator's line.** The source comment notes it gives "two independent end-of-run
  markers on two different pods, which matters in a deployment that demonstrably drops log records."
  Under the new rule it simply is not counted.

### What the redesign touches when someone writes it up

- `src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs` — emit the terminal outcome
- `src/BaseApi.Service/Features/Orchestration/OrchestrationService.cs` — emit `{EntityId, EntityName}`
  per entity between validation (line ~108) and `SendAsync` (line ~130), where the
  `WorkflowGraphSnapshot` still holds `WorkflowReadDto` / `StepReadDto` / `ProcessorReadDto`, each
  carrying `Name` and `Version`. **Not** the handler — `WorkflowL1`/`StepL1` are ids-only.
- spec §4.1, §4.2, §4.3, §6.1, §6.5, §6.6, §9
- the dashboard query, the control group's ignore settings, the data view's `fieldFormats`
- `tools/verify-kibana-dashboard.py` — `PER_CYCLE_BY_STEP` keys, `PER_CYCLE_BY_PROCESSOR`,
  `VALIDATION_WORKFLOW` all become `{name}_{version}`
- `elastic/` shrinks to the Kibana export plus a formatter generator
- `docs/testing/kibana-operator-dashboard.md` — the §4.4 tables and the zoom guidance

## Open items

1. ~~**Write the spec amendment and the plan.**~~ **Done 2026-09-22.** Spec §13 amends
   §§4.1, 4.2, 4.3, 6.1, 6.3, 6.5, 6.6, 7.1 and 9, each of which now carries a banner pointing
   at it. The plan is `docs/superpowers/plans/2026-09-22-kibana-dashboard-offline-redesign.md`,
   six tasks, with the `elastic/` cleanup of item 6 below as its Task 6 and the diagram question
   of item 7 as a deferred decision carrying a pre-committed default. **Nothing is implemented.**
2. **check 9** needs a second workflow driven. Five workflows are stopped.
3. **Org-cluster unknowns**, stated to the user and unanswered: whether Kibana is already provided,
   whether data-view edits are permitted, the Kibana version, the Space, and whether the data stream
   is `logs-generic.otel-default` with `all_strings_to_keywords` in force.
4. **`unknownKeyValue`** behaviour for an unmapped GUID is untested — get it wrong and a new entity
   renders blank instead of showing its id.
5. **Free-text search regresses** under the formatter approach: names exist only at render time, so
   an operator filtering in KQL or Discover must type the GUID.

## Two more tasks the user asked for

### 6. Delete the redundant files in `elastic/`

**Not yet — every one of them is live today.** The dashboard in the cluster is driven by the
pipeline and policy these files define, so deleting them now breaks a working dashboard and leaves
no way to rebuild it. This is a task for **after** the redesign lands.

What `elastic/` holds now, and what happens to each:

| file | fate under the redesign |
| --- | --- |
| `logs-custom-pipeline.json` | **delete** — there is no ingest pipeline any more |
| `enrich-policy.json` | **delete** — no enrich policy |
| `entity-names-index.json` | **delete** — no lookup index |
| `simulate-outcome-classification.json` | **delete** — it is the pipeline's test fixture |
| `kibana-export.ndjson` | **keep** — it becomes the whole deliverable |
| `README.md` | **rewrite** — the install order it documents is the thing being removed |

Two things that must move somewhere before those deletions, or they are lost:

- The **classification rule** currently lives in `logs-custom-pipeline.json`. Under the redesign it
  becomes the dashboard-level KQL query. Until that query exists and is verified, the pipeline file
  is the only definition.
- `simulate-outcome-classification.json` is a real test — twelve documents, one per template of §4,
  with the expected classification tabulated in the plan. If the rule moves to KQL it needs an
  equivalent test, or the three rarely-fired failure templates go back to being unverified.

Also delete the now-unused `tools/sync-entity-names.py` at the same time, and strip the ES-object
install steps from `elastic/README.md`.

### 7. Can the chain diagram be embedded in the dashboard?

Target: `docs/diagrams/filefetcher-archiveexpander-chain.html` — 33 KB, self-contained, three inline
`<svg>` blocks, no external scripts. It was captured live from the API on 2026-09-15 and its header
records that provenance.

**Established this session, against the live Kibana 8.15.5:**

- **`links` panel: available** (`links` is an allowed saved-object type). It renders a list of links,
  it does not embed content.
- **Image panel: probably available.** `image` is not an allowed saved-object type, but
  `POST /api/files/find` returns **200**, so the Files plugin that backs the Image embeddable is
  present. Confirm in the UI before planning around it.
- **There is no iframe or raw-HTML panel in Kibana**, and the Markdown/Text panel sanitizes HTML, so
  inline `<svg>` will not render through it. A straight embed of this file is not available.
- **`file:///C:/...` will not load** from a page served at `http://localhost:15601`. Browsers block
  file-scheme subresources and navigation from an http origin, so the local path cannot be used as a
  link target or a panel source regardless of which panel type is chosen.

So the realistic options, in the order I would try them:

1. **Render the diagram to an image and use the Image panel.** Keeps it visually on the dashboard.
   Costs the diagram's interactivity, and the image becomes a second copy that drifts from the HTML.
2. **Serve the HTML over http and add a `links` panel** pointing at it — one click away rather than
   embedded, but it stays a single source. Needs somewhere to serve it from; nothing in `k8s/` does
   that today.
3. **Re-author as a Vega visualisation.** A true dashboard panel, but it is a hand-drawn schematic
   and this is a substantial rewrite.
4. **Leave it out and link it from `docs/testing/kibana-operator-dashboard.md`.** Cheapest, and the
   operator notes are already the place a reader is sent.

Worth deciding what the diagram is *for* on the dashboard before picking: if it is orientation for a
newcomer, option 4 is enough; if it is meant to be read beside the bars while diagnosing, option 1 or
2 earn their cost.

## How to work on this

Browser automation used the `playwright-skill` in **headless** mode (the host was low on memory).
Scripts live in the scratchpad; the pattern is: publish a saved object through the Kibana API, then
render it and read the legend/labels back to prove it works. Hand-written Lens state imports clean
and renders nothing, so "it renders with data" is the only check that means anything.

The Kibana saved-object ids are fixed on purpose — `skp-logs`, `skp-outcomes-bins`,
`skp-outcomes-pie`, `skp-outcome-records`, `skp-operator-outcomes`. Check 9 asserts on them and a
generated UUID breaks every re-import.
