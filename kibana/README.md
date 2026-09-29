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
| `kibana-export.ndjson` | the whole deliverable — data view, 3 Lens panels, 1 agg-based panel, dashboard, and the diagram panel |
| `publish-diagram.py` | draws a workflow from the live graph, gates it in a browser, and PUTs it to the workflow row |

**The diagram panel lives in the export, not in a script.** `set-diagram-panel.py` used to write it
— a TSVB panel whose markdown is `{{#each _all}}![](<base>/{{label}}.svg){{/each}}`, split on
`attributes.WorkflowId` so each series label is a workflow id the template turns into a URL. It was
one-time wiring: the panel resolves the id at REQUEST time, so a new or redrawn diagram needs
nothing done to the dashboard, and the only thing the script encoded was the base URL as the
operator's browser sees it. It was retired once the panel it produces was committed here.

To repoint it at a different BaseApi — another host, or the air-gapped stack — edit `p3`'s
`embeddableConfig` in the ndjson and re-import. Note the committed panel is `h: 14`, which is not
what the retired script wrote (`23`), so the export is the authority on its own layout.

## How names work

Panels and controls aggregate on the **name field** — `attributes.WorkflowName`,
`attributes.StepName` — which carries `{name}_{version}-{last two GUID groups}` (an id whose name
never resolved in L2 logs the suffix alone, e.g. `9aff-a7f22ee09224`). The name is **set on the
record by the orchestrator or the processor that emits it**, resolved at build time from
`skp:name:{id}` in L2 — the key BaseApi writes for every workflow, step and processor. Kibana holds
nothing: the `skp-logs` data view has an empty `fieldFormatMap` and an empty `runtimeFieldMap`, and
nothing pushes to it or triggers it.

**The Elasticsearch plumbing that used to do this is retired.** A `skp-entity-lookup` index, its
enrich policy, and a `logs@custom` ingest pipeline used to stamp the name onto each record at
ingest time; BaseApi no longer creates any of the three. Run
`tools/offline/teardown-entity-lookup.py` against every stack BaseApi has ever booted against — it
is mandatory before the new processors log there, because while the pipeline exists its enrich step
overwrites the names the processes set with the old `name_version` format.

**An unmatched id renders as its own suffix**, not as blank and not as a shared "unknown" string. A
missing field would give a panel a *missing* bucket that reads as a different entity; one shared
string would merge two unlabelled entities into one.

Names are set on the records by the orchestrator and the processors themselves, resolved from
`skp:name:{id}` in L2 (`{name}_{version}-{last two GUID groups}`; an unresolved id logs the suffix
alone). There is no ingest pipeline and no lookup index any more. The whitelist board splits on the
pair `attributes.StepName` + `attributes.WhitelistRoot` (`multi_terms`, one pie per pair);
`WhitelistOwner` is retired. The Workflow control's pinned value is environment-specific: run
`python tools/offline/pin-workflow-control.py --workflow filefetcher-archiveexpander-chain_1.0.0`
against the stack's Redis before importing this export. The script resolves the live workflow id
from BaseApi's own registry (`--api-url`, default `http://localhost:18080`) rather than scanning L2
directly, because a rebuild leaves stale `skp:name:*` entries behind under the old id; pass
`--api-url` when the stack's BaseApi is not on the default address (the offline machine's usually
is not), or `--workflow-id` to skip the registry lookup entirely.

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

The `logs@custom` enrich pipeline that replaced the `static_lookup` formatter was itself retired on
2026-09-29.

## Why the dropdowns carry a filter

The control group sets `ignoreQuery` so that a naming record — which carries no `Result` — can
supply an option at all. It does **not** ignore the time range: the dropdowns list what is relevant
to the window on screen, 2 workflows and 13 steps over 15 minutes here, 6 and 40 over 30 days.

Ignoring the time range was tried and reverted. It made the option lists **every id ever indexed**. Measured on the dev cluster: **156 workflows and 780 steps**, against
a registry holding 6 and 42. The rest are dead ids from earlier rebuilds of the graph — the rebuild
runbook mints fresh GUIDs every time, and the index remembers all of them. None has a naming record,
so they render as raw GUIDs and bury the handful that matter.

The dashboard therefore carries one filter, `outcomes, lookups and refusals`:

```
attributes.Result exists  OR  attributes.WhitelistVerdict exists
                          OR  (severity_text = Error AND attributes.Queue exists)
```

The third clause arrived with the refusal table and is the reason the filter was renamed. It admits
a record that has no `Result` at all, so unlike the first two it is NOT a superset of the counted
set — it is a disjoint third atom. It still moves no count, because every panel carries its own
guard.

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

## What counts as a refusal, and why it is on this board at all

A step outcome says what a run decided. A **refusal** is a run that never got to decide: the
consumer rejected the delivery without requeue, the broker dead-lettered it, and no `StepOutcome`
was ever sent. **No outcome panel can show that, at any severity, ever** — there is no record with an
`attributes.Result` to count. The board would read green for work that was thrown away, which is
precisely how six parked outcomes sat unnoticed across two days on the live stack.

One panel, `skp-parked-table`, **beside the outcome pie rather than below the board**: the pie says
what the runs decided, the table says what never got to decide, and the pairing is the point. A
refusal panel parked at the bottom of a long board is a refusal panel nobody scrolls to, which is
how six parked outcomes went unnoticed for two days in the first place.

A second panel — a bar chart of refusals over time, `skp-parked-bins` — was built and then removed.
Two panels answered one question, and the table answers it better: a bar says a workflow lost
messages, the table says which queue, which message type, and whether they are still recoverable.

Two clauses that do different jobs, and the split is deliberate.

The dashboard **query** is KQL and stays a shape:

```
severity_text:"Error" and attributes.Queue:*
```

The dashboard **filter** is DSL and is an identity — it enumerates the two log templates:

```
severity_text = "Error"
AND attributes.{OriginalFormat} IN (
      "refusing message of type {Type} on {Queue} — parked",
      "refusing message of type {Type} on {Queue} — NOT parked: the channel was gone before …" )
```

They AND together, so the DSL half is what actually bounds the panel. `attributes.{OriginalFormat}`
holds the message template **before** substitution — identical on every record from one `LogError`
call — so naming the two strings closes the set by identity rather than inferring a refusal from a
shape. Measured: against one real park record and one synthetic `Error`-with-a-`{Queue}` from a
different template, the shape matches **2** and the identity matches **1**.

Braces never reach KQL. That was the only reason the field was avoided in the selector, and putting
the templates in the DSL filter — which the dashboard already carries — sidesteps it entirely.

`severity_text:"Error"` is kept in both halves although the templates alone would do. It costs
nothing and changes the failure direction: if someone rewords a template without updating
`Templates.cs`, the record still satisfies the KQL shape and shows up as a wrong-looking row rather
than vanishing and leaving a silently empty panel.

**The strings are the live suite's, not retyped.** `Templates.cs` pins both as `RefusingAndParking`
and `RefusingNotParked`, and the resilience suite matches records by them — so a reword that was not
propagated fails a test before it empties a dashboard. That guard is what makes template-identity the
safer choice here, where in most codebases it would be the riskier one.

**The severity half is load-bearing, not decoration.** `attributes.Queue` also rides
Information-level startup lines (`consumption admitted … consuming {Queue}`, `reply queue {Queue}
bound`) and both WARNING-level *requeue* lines. A requeue is not lost work — the message comes back
— so counting those would turn every store outage into a wall of phantom losses. `Error` + `Queue`
is exactly `GatedQueueConsumer`'s park branch, on both sides: orchestrator and processor run the
same consumer, and BaseApi's copy writes the identical record.

**It had to widen the dashboard's query AND its filter.** Both previously admitted only a record
carrying `Result` or `WhitelistVerdict`; the dashboard's query and filter AND with every panel's
own, so the two panels rendered permanently empty until the third clause existed. It moves no
count — measured against the live store, the outcome selector under the widened filter matches the
same 181,732 records and zero refusals, because each panel still carries its own guard.

### The Outcome column is the whole point of the table

`- parked` means the broker was told, and the message **is** in that queue's `.dead` counterpart,
recoverable by hand. `- NOT parked: the channel was gone before the broker was told` means it will
be **redelivered** and there is nothing in a dead-letter queue to find. Those are one code branch,
one metric bucket (`disposition="parked"`) and one severity — the log line is the only thing that
distinguishes them. An operator who cannot tell them apart either hunts for a message that was
never parked, or ignores one that was.

The column is **two labelled buckets, not the raw log template**, and that was a correction made
against a screenshot rather than a preference. Terming on `attributes.{OriginalFormat}` put the
discriminating words at the END of a 60-to-150 character string and the column truncated them: a
parked row and a redelivered one both rendered as `refusing message of type {Type} o`, identical,
which defeats the only thing this column is for. The buckets split on `body.text`, which is
`match_only_text` and so answers a phrase query — the `attributes.*` fields are all `keyword`, where
a match returns zero silently.

A `filters` column emits its bucket even when nothing matches it, so every group shows both rows.
That is kept deliberately, with `emptyAsNull` off so the empty one reads `0` rather than `(null)`:
"NOT parked: 0" is the statement that the whole group **is** in the dead-letter queue and can be
recovered by hand, which is the actionable half.

### The ids come off the headers, not the body

A refusal is logged from a catch block, where the handler's own log scope has already been disposed
by the unwinding exception — so for a long time these records carried no ids at all and could not be
paired to anything. `MessageIdHeaders` now stamps six `x-skp-*` AMQP headers at send and the
consumer lifts them back under the **log-scope** names, so a refusal lands on the same
`attributes.WorkflowId` / `StepId` / `ProcessorId` fields an outcome does — which is what lets the
gated consumer set `attributes.WorkflowName` and the rest directly on the refusal line, and what
makes the controls at the top of this board filter it like anything else. The headers survive into
the dead-letter queue too, so the same ids appear on the log line and on the parked message.

**`missingBucket` is true on every dimension of both panels, deliberately.** A refusal whose body
would not deserialize, or one predating the header stamping, has no workflow id — and a refusal
dropped for want of a label is lost work the board reports as absent, which is the exact failure
these panels exist to end. It renders as its own bucket instead. Of the ten messages parked on the
live stack, nine carry the id and the tenth is this case.

### Coverage

The park branch does not fire in normal traffic — it had not fired once in the current log store —
so `tools/classification-fixture.json` carries documents 14 and 15 for it, one per half of the
branch, both `counted: false`. That is the only guard there is against the widened rule quietly
starting to count refusals as outcomes; check 10 runs it.

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
