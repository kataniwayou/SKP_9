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
| `kibana-export.ndjson` | the whole deliverable — data view, 3 Lens panels, dashboard |
| `generate-field-formatters.py` | writes the id → `{name}_{version}` lookup into the data view |
| `build-diagram-panel.py` | regenerates the chain diagram panel from the committed HTML |
| `filefetcher-archiveexpander-chain.svg` | the self-contained diagram, generated — do not hand-edit |

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
Regenerate after publishing or renaming anything, then re-import:

```
python kibana/generate-field-formatters.py
```

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

The panel shows **the diagram of the workflow you have selected**, and nothing when there isn't one.

It is a **TSVB markdown** panel, not the plain Markdown panel, and that is the whole mechanism. A
Markdown panel runs no query, so it cannot react to anything. TSVB runs one, so it honours the
Workflow control, the filter and the time range. Splitting that query by `attributes.WorkflowId`
makes each series label the id itself, and the template turns the id into a filename:

```
{{#each _all}}![](http://<base>/{{label}}.png){{/each}}
```

**Nothing renders when there is no diagram, by two independent routes.** A workflow with no records
in the window produces no series, so the loop runs zero times. A workflow with records but no file
gets a 404 — and because the alt text is deliberately **empty**, a broken image collapses to
nothing. With alt text it would show a placeholder icon and the alt string.

Regenerate after editing any diagram, then re-import the export and re-apply the manifest:

```
python kibana/build-diagram-panels.py --base-url http://localhost:18097
kubectl apply --server-side -f k8s/25-diagrams.yaml
```

`--server-side` is not optional: the ConfigMap is ~370 KB, which overflows the
`last-applied-configuration` annotation a client-side apply writes (262144 bytes). That is also why
`25-diagrams.yaml` is not in `kustomization.yaml`.

**The images are served, not embedded**, which is what lets the filename vary with the selection. A
data URI is fixed at build time. `k8s/25-diagrams.yaml` is a generated ConfigMap of PNGs behind an
nginx, reachable on `localhost:18097`; **the operator's browser fetches them, not Kibana**, so it
must be reachable from wherever the dashboard is opened and `--base-url` must match.

**Filenames are workflow ids, so they change per cluster.** The registry in the build script is
keyed by workflow *name*, which survives a rebuild; the id is resolved at build time from the same
naming records the formatters use. Rebuild the graph elsewhere and re-run the script.

**With no workflow selected and several in range the diagrams stack**, and the panel scrolls rather
than hiding the ones after the first. Selecting a workflow collapses it to one.

