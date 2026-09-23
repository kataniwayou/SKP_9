# kibana/

Everything the operator dashboard needs, and **nothing that lives in Elasticsearch**.

Design: `docs/superpowers/specs/2026-09-22-kibana-operator-dashboard-design.md` — read §13 first,
which amends §1–§12. Nothing here is provisioned by kustomize, the same posture as
`grafana/dashboards/*.json`. Kibana itself IS manifested, at `k8s/24-kibana.yaml`; Elasticsearch
deliberately is not.

## Install

One step.

```
kibana-export.ndjson → Kibana → Stack Management → Saved Objects → Import
```

There is no order to get right any more, because there is nothing else to install. Previous
versions of this file documented a four-step sequence — a lookup index, an enrich policy, an
execute, then an ingest pipeline claiming `logs@custom` — and warned that the order was
load-bearing. All four objects are gone, along with the two cluster privileges they needed
(`manage_pipeline`, `manage_enrich`) and the claim on `logs@custom`, which is a single cluster-wide
slot shared with every other team that ships logs through the stock `logs` template.

That matters because this dashboard is going to an Elasticsearch **this project does not own**. It
now needs read access and nothing else.

## What is here

| file | what it is |
|---|---|
| `kibana-export.ndjson` | the whole deliverable — data view, 2 Lens panels, 1 agg-based panel, dashboard |
| `set-diagram-panel.py` | points the diagram panel at the BaseApi that serves the drawings |
| `publish-diagram.py` | extracts a drawing from its HTML page and PUTs it to the workflow row |

## How names work

Panels and controls aggregate on the **raw id** — `attributes.WorkflowId`, `attributes.StepId`,
`attributes.ProcessorId`. The data view carries a `static_lookup` field formatter per id field, and
Kibana substitutes `{name}_{version}` when it draws. Nothing is written to Elasticsearch, and
because formatting happens at read time it covers **all history**, including records indexed long
before any of this existed.

The pairs come from the log store: `OrchestrationService` writes one record per entity when a
workflow is started, carrying the id under the same field name the execution records use.

| kind | fields |
|---|---|
| workflow | `WorkflowId` + `EntityName` |
| step | `StepId` + `WorkflowId` + `EntityName` |
| processor | `ProcessorId` + `EntityName` |

The step's `WorkflowId` is what lets the Step dropdown stay the published topology when a workflow is
selected; without it, chaining can only match execution records and the list falls back to steps that
have run. A processor carries no workflow id — it is chained under nothing and is shared across
workflows.
**Nobody regenerates this.** The BaseApi publishes the table into the data view itself, triggered by
a dashboard render: the panel fetches `lookup/ping.svg`, and that request republishes the map if a
render has not asked recently. It is sourced from the entity tables rather than from naming records
in the log store, which is why a workflow that has only ever run on the cron is nameable — the old
generator read records written on an explicit start and never by the cron, so those entities had no
names at all.

Two consequences worth knowing:

- **The dashboard is one render behind.** Kibana loads the data view before the panels render, so a
  push triggered by a render lands on the *next* view. Publish something, and the first look shows
  raw GUIDs; refresh once and the names appear.
- **Importing this export overwrites the table** with whatever copy the file carries, because the
  data view is one of the five objects. That corrects itself on the next render.

**A workflow must have been started at least once for its entities to have names.** Those records
are written on an explicit start and not again — the cron fires from the orchestrator, against an
ids-only projection, and never comes through the BaseApi. A workflow whose last start has aged out
of the index has no pairs, and its ids render as raw GUIDs until it is next started. That is the one
operational cost of sourcing names from logs, and it is why the generator searches all of time
rather than a recent window.

Two consequences worth knowing before you are surprised by them:

- **Free-text search needs the GUID.** Names exist only at render time. An operator filtering in KQL
  or hunting in Discover must type the id.
- **A version bump relabels history.** The lookup is a flat map applied to all of time and `Version`
  is mutable on the same row, so `{name}_{version}` means "what this is called now", not what it was
  called when the record was written.

An id with no entry renders as **itself** — the raw GUID. That is deliberate: the formatters omit
`unknownKeyValue`, because setting it would render every unmapped entity as one shared string and
collapse two unlabelled steps into a single legend bucket.

## Why the dropdowns carry a filter

The control group sets `ignoreQuery` so that a naming record — which carries no `Result` — can
supply an option at all. It does **not** ignore the time range: the dropdowns list what is relevant
to the window on screen, 2 workflows and 13 steps over 15 minutes here, 6 and 40 over 30 days.

Ignoring the time range was tried and reverted. It made the option lists **every id ever indexed**. Measured on the dev cluster: **156 workflows and 780 steps**, against
a registry holding 6 and 42. The rest are dead ids from earlier rebuilds of the graph — the rebuild
runbook mints fresh GUIDs every time, and the index remembers all of them. None has a naming record,
so they render as raw GUIDs and bury the handful that matter.

The dashboard therefore carries one filter, `entities, not archaeology`:

```
attributes.Result exists  OR  attributes.EntityName exists
```

A filter rather than a query, because `ignoreFilters` is deliberately left **false** — it is the one
parent setting the controls still respect. And it is a **superset of the counted set**, so it bounds
the dropdowns without moving a single count: every counted record carries a Result and therefore
matches it. At a 30-day range it gives 6 workflows and 40 steps — the registry — rather than
156 and 780.

Check 11 asserts the filter is present. Remove it and the dropdowns quietly fill with archaeology.

## What counts as a step outcome

One clause, stated once, in the dashboard's own query:

```
attributes.Result:* and not resource.attributes.service.name:"orchestrator"
```

It used to take two clauses and a pipeline-written flag, because a terminal step's success was
invisible on the processor side — an exporter sends no branch, so nothing reported it and the rule
had to reach into the orchestrator's records for that one case. `ProcessDispatchHandler` now emits
the terminal outcome itself, so a sink is an ordinary step.

The orchestrator still emits its own end-of-run line and that is deliberate: two independent markers
on two different pods is the only mitigation there is for a deployment that demonstrably drops log
records. It is simply not counted.

After changing the rule, run the checks. Check 10 runs it against `tools/classification-fixture.json`
— 13 synthetic documents, one per template — which is the only coverage the three rarely-fired
failure paths get, since they never appear in live traffic. The fixture lives beside the check
rather than here: nothing in this directory is test data, and nothing in it is anything but what
you import into Kibana.

```
python tools/verify-kibana-dashboard.py
```

## The diagram panel, and how it follows the selection

The panel shows **the diagram of the workflow you have selected**, and says so plainly when that
workflow has none.

It is a **TSVB markdown** panel, not the plain Markdown panel, and that is the whole mechanism. A
Markdown panel runs no query, so it cannot react to anything. TSVB runs one, so it honours the
Workflow control, the filter and the time range. Splitting that query by `attributes.WorkflowId`
makes each series label the id itself, and the template turns the id into a URL:

```
{{#each _all}}![](http://<base>/{{label}}.svg){{/each}}
```

**The drawings live on the workflow row and are served by the BaseApi.** `WorkflowEntity.Diagram`
holds SVG source; `GET /api/v1/workflows/{id}.svg` returns it. The id is last in the path because
the template can only concatenate a base with the label — it cannot express a segment after the id.

**The operator's browser fetches the drawing, not Kibana.** So the BaseApi must be reachable from
wherever the dashboard is opened, and the base URL baked into the panel must match. On this cluster
that is the supervised forward on 18080.

**A workflow with no diagram is an ordinary state, not an error.** The column is null until someone
publishes one, and the GET answers null with a placeholder that says *"No diagram published for this
workflow"*. That keeps two cases apart which used to look identical: a workflow nobody has drawn now
renders a card that says so, while an unreachable API still renders **nothing at all**, because the
image tag's alt text is deliberately empty.

**Enriching a workflow is the operator's choice.** Nothing publishes a diagram automatically, and a
workflow that never gets one serves the placeholder indefinitely.

Three steps, one command:

| step | what the operator does |
|---|---|
| **1. Create the entities** | POST the workflow, steps, assignments and schema rows to the BaseApi |
| **2. Run the script** | `python kibana/publish-diagram.py <workflow-name>` |
| **3. Verify visually** | open the dashboard, or `node run.js tools/verify-diagram-render.js` |

Step 2 reads the live graph, draws it, gates it and publishes it to the workflow row. The gate is
structural and refuses to publish a broken drawing: every failure edge must reach its sink, nothing
may leave the viewBox, no attribute may be declared twice and the SVG must parse. Text metrics need
a real renderer, which is step 3 — a duplicated `xmlns` once served as 200 `image/svg+xml` with
correct bytes and rendered as nothing at all.

The layout rules it implements are specified in
[`docs/diagrams/workflow-diagram-prompt.md`](../docs/diagrams/workflow-diagram-prompt.md), which is
also where the two things a script cannot draw are described — interpretive annotations, and the
Cancelled paths that exist only in processor source.

**The drawing is read from the live graph every time**, so it is current by construction rather than
because someone remembered to redraw it. The two committed pages in `docs/diagrams/` are no longer
publish sources: they are the style goldens `verify-diagram-style.py` compares against.

`verify-diagram-style.py` is what keeps a new drawing consistent with the existing ones. It asserts
the token palette, the type ladder, the 1580 viewBox width and the class vocabulary, and never
compares content — two runs of a generative task differ in coordinates, and the graph moves
underneath them, so a byte or geometry diff would fail for reasons that are not defects.

**Filenames no longer change per cluster.** The id is resolved at request time from the row itself,
so rebuilding the graph elsewhere needs no regeneration. The retired design rendered each drawing to
PNG, base64'd them into a ConfigMap keyed by workflow id and stood an nginx in front of it; those
ids were fixed at build time, so every rebuild orphaned the images.

**With no workflow selected and several in range the diagrams stack**, and the panel scrolls rather
than hiding the ones after the first. Selecting a workflow collapses it to one.
