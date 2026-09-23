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

Panels and controls aggregate on the **name field** — `attributes.WorkflowName`,
`attributes.StepName` — which carries `{name}_{version}`. The name is written **into each log
record at ingest**, so Kibana holds nothing: the `skp-logs` data view has an empty
`fieldFormatMap` and an empty `runtimeFieldMap`, and nothing pushes to it or triggers it.

Three Elasticsearch objects do the work, all created by BaseApi at boot and owned by no human:

| Object | Role |
| --- | --- |
| `skp-entity-lookup` index | one row per entity, `_id` = its GUID, holding `name`, `version`, `kind` |
| `skp-entity-lookup` enrich policy | matches a document's id against that index |
| `logs@custom` ingest pipeline | stamps the name onto each record; x-pack's managed `logs@default-pipeline` already calls it |

**The table is written at workflow start**, from the validated graph snapshot, before the
`StartOrchestration` message is sent. A workflow's ids reach the log store only once the
orchestrator has been told to run it, and a running workflow's composition is frozen at start by
the L2 projection — so the graph in hand at that moment is exactly the set of ids the run can emit.
Entity rows edited afterwards cannot reach it, which is the point: the label says what the thing was
called **when it ran**.

The ordering is load-bearing. Enrichment is frozen at index time, so a record written before its id
is in the materialised policy is unnamed permanently and no later publish repairs it.

**An unmatched id renders as its own GUID**, not as blank and not as a shared "unknown" string. A
missing field would give a panel a *missing* bucket that reads as a different entity; one shared
string would merge two unlabelled entities into one. This is the same choice the retired
`static_lookup` formatter made by omitting `unknownKeyValue`.

`attributes.WhitelistOwner` is built the same way, by a `set` processor joining the enriched step
name to the record's own `WhitelistRoot`. It replaced a runtime field whose readable half came from
a formatter nothing regenerated — a newly gated step drew a pie titled `{GUID} · {root}` until
somebody hand-edited the export.

### What this replaced, and what went with it

`KibanaLookupPublisher` pushed a `static_lookup` formatter onto the data view, triggered by a
dashboard render fetching `lookup/ping.svg`. Formatting happened at read time and therefore covered
all history, including a rename — which is the one thing lost here. It also meant BaseApi held a
Kibana address and an API key, a Kibana outage meant stale labels, and re-importing this export
silently reverted the table until the next render.

Before that, `OrchestrationService` emitted a naming record per entity on every accepted start.
That covered only explicitly started workflows, never the cron path, and decayed out of the index
with retention.

One guarantee is common to all three designs and worth restating: a control lists values **present
in the field**, so a step that has never executed is in no dropdown. Under the current design that
is structural rather than incidental — the name is stamped onto records, and a step that never ran
has none.

## Why the dropdowns carry a filter

The control group sets `ignoreQuery` so that a naming record — which carries no `Result` — can
supply an option at all. It does **not** ignore the time range: the dropdowns list what is relevant
to the window on screen, 2 workflows and 13 steps over 15 minutes here, 6 and 40 over 30 days.

Ignoring the time range was tried and reverted. It made the option lists **every id ever indexed**. Measured on the dev cluster: **156 workflows and 780 steps**, against
a registry holding 6 and 42. The rest are dead ids from earlier rebuilds of the graph — the rebuild
runbook mints fresh GUIDs every time, and the index remembers all of them. None has a naming record,
so they render as raw GUIDs and bury the handful that matter.

The dashboard therefore carries one filter, `outcomes and lookups`:

```
attributes.Result exists  OR  attributes.WhitelistVerdict exists
```

(An `attributes.EntityName exists` clause sat here too, admitting the naming records described
above. It was removed with them. Because every id in those records also appears in execution
records, dropping it changes no dropdown.)

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
| *(verification)* | runs inside step 2 against the candidate; a failure refuses the publish |

Step 2 reads the live graph, draws it, gates it and publishes it to the workflow row. Both checks
run on the candidate, before the PUT — verifying what you are about to publish is strictly stronger
than verifying what you already did.

**The coordinate gate** refuses a structurally broken drawing: every edge in the graph must be
drawn, every edge whose source declares an output schema must be *labelled with it*, every failure
edge must reach its sink, every assignment key *and its value* must appear verbatim, the strip
above the drawing must carry the workflow’s own `cronExpression`, nothing may leave the viewBox, no
attribute may be declared twice, and the SVG must parse.

**The browser check** measures what only a renderer can see: that the image loads at all, that no
text measures 0px or overlaps another, that no path or line renders without a stroke, and that the
canvas is no bigger than the drawing on it — no side margin over 160px, and no more than 48px
between the boxes and the assignment lines. The last two are regressions with names: a fixed
1580-wide canvas scaled a three-step drawing down to a third of the panel, and a fixed failure row
left 236px of empty lane in a graph that has no failure sink.

The layout rules are the script's own — `STYLE_ROOT`, `STYLE_RULES` and the geometry constants at
the top of it. There is no separate specification: `docs/diagrams/workflow-diagram-prompt.md` held
one while the drawings were produced by hand from a prompt, and was retired with the rest of that
flow. The two things a script cannot draw are recorded in the script's own header, under WHAT A
SCRIPT CANNOT DRAW.

**The drawing is read from the live graph every time**, so it is current by construction rather than
because someone remembered to redraw it. The two committed pages that used to live in
`docs/diagrams/` are deleted: they stopped being publish sources when this script took over, stopped
being style goldens when the style check was retired, and were removed once nothing read them. The
directory is gone with them — interpretive annotations and the Cancelled paths that exist only in
processor source are now described in `publish-diagram.py`'s header rather than drawn anywhere.

**There is no separate style check any more, and there is nothing left for one to catch.**
`tools/verify-diagram-style.py` compared a candidate's class vocabulary against one of those pages
and was retired just before them. It made sense while the drawings were produced by an agentic task
from a prompt, where the design system existed only as an example someone had to match. It stopped
making sense when `publish-diagram.py` took the style system into `STYLE_RULES` and emitted rules
only for the classes a drawing actually uses: a class with no treatment can no longer be drawn, so
the invariant is held by construction rather than asserted afterwards. Left running, it failed on
ten classes that are all correct — the arrowheads, the bypass path, the cron strip and the legend —
because its reference page predates every one of them.

**Filenames no longer change per cluster.** The id is resolved at request time from the row itself,
so rebuilding the graph elsewhere needs no regeneration. The retired design rendered each drawing to
PNG, base64'd them into a ConfigMap keyed by workflow id and stood an nginx in front of it; those
ids were fixed at build time, so every rebuild orphaned the images.

**With no workflow selected and several in range the diagrams stack**, and the panel scrolls rather
than hiding the ones after the first. Selecting a workflow collapses it to one.
