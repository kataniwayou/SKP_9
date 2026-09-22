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
| `kibana-export.ndjson` | the whole deliverable — data view, 2 Lens panels, saved search, dashboard |
| `generate-field-formatters.py` | writes the id → `{name}_{version}` lookup into the data view |
| `build-diagram-panel.py` | regenerates the chain diagram panel from the committed HTML |
| `classification-fixture.json` | the counted-set test: 13 documents, one per template |

## How names work

Panels and controls aggregate on the **raw id** — `attributes.WorkflowId`, `attributes.StepId`,
`attributes.ProcessorId`. The data view carries a `static_lookup` field formatter per id field, and
Kibana substitutes `{name}_{version}` when it draws. Nothing is written to Elasticsearch, and
because formatting happens at read time it covers **all history**, including records indexed long
before any of this existed.

The pairs come from the log store: `OrchestrationService` writes one record per entity when a
workflow is started, carrying the id under the same field name the execution records use.
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

After changing the rule, run the fixture — it is the only coverage the three rarely-fired failure
templates get:

```
python tools/verify-kibana-dashboard.py
```

## Regenerating the diagram panel

The chain diagram is a PNG data URI inside a markdown panel, because Kibana has no panel that takes
the diagram's HTML and a data URI needs no server to host it. The raster is generated, never
hand-edited:

```
python kibana/build-diagram-panel.py
```

Re-run it after editing `docs/diagrams/filefetcher-archiveexpander-chain.html`, then re-import.
